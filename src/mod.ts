import { MetadataArgsStorage } from "./metadata/metadata.ts";
import { serve, Server, HTTPOptions } from "./deps.ts";
import { getAction } from "./route/get-action.ts";
import { getActionParams } from "./route/get-action-params.ts";
import { StaticFilesConfig } from "./models/static-config.ts";
import { ViewRenderConfig } from "./models/view-render-config.ts";
import { CorsBuilder } from "./middlewares/cors-builder.ts";
import { Content } from "./renderer/content.ts";
import { RouteMetadata } from "./metadata/route.ts";
import { registerAreas } from "./utils/register-areas.ts";
import { registerControllers } from "./utils/register-controllers.ts";
import { getStaticFile } from "./utils/get-static-file.ts";
import { MiddlewareTarget } from "./models/middleware-target.ts";
import {
  TransformConfigMap,
  TransformConfig,
} from "./models/transform-config.ts";

import { HookMetadataArgs } from "./metadata/hook.ts";
import { Context } from "./models/context.ts";
import { notFoundAction } from "./renderer/not-found.ts";
import { AppSettings } from "./models/app-settings.ts";
import { getHooksForAction } from "./route/get-hooks.ts";
import { HookMethod } from "./models/hook.ts";
import { HttpError } from "./http-error/HttpError.ts";
import { DependencyContainer, InternalDependencyContainer } from "./injection/index.ts";

export type ObjectKeyAny = { [key: string]: any };

const global: ObjectKeyAny = {};

export function getMetadataArgsStorage<TState>(): MetadataArgsStorage<TState> {
  if (!(global as any).routingControllersMetadataArgsStorage) {
    (global as any).routingControllersMetadataArgsStorage =
      new MetadataArgsStorage();
  }

  return (global as any).routingControllersMetadataArgsStorage;
}

export function getViewRenderConfig(): ViewRenderConfig {
  return (global as any).viewRenderConfig;
}

// TODO(irustm): move to hooks function
/**
 * Run hooks function and return true if response is immediately
 */
async function resolveHooks<TState, TPayload>(
  context: Context<TState>,
  actionName: HookMethod,
  hooks?: HookMetadataArgs<TState, TPayload>[],
): Promise<boolean> {
  const resolvedHooks = new Set<HookMetadataArgs<TState, TPayload>>();

  if (hasHooks(hooks)) {
    // @ts-ignore: Object is possibly 'undefined'.
    for (const hook of hooks) {
      const action: Function | undefined = (hook as any).instance[actionName];

      if (action !== undefined) {
        await (hook as any).instance[actionName](context, hook.payload);

        if (context.response.isImmediately()) {
          let reverseActionName: HookMethod = actionName === "onCatchAction"
            ? "onCatchAction"
            : "onPostAction";

          // run reverse resolved hooks
          await runHooks(
            context,
            reverseActionName,
            Array.from(resolvedHooks).reverse(),
          );

          await context.request.serverRequest.respond(
            context.response.getMergedResult(),
          );
          return true;
        }
      }
      resolvedHooks.add(hook);
    }
  }

  return false;
}

function hasHooks<TState = any, TPayload = any>(
  hooks?: HookMetadataArgs<TState, TPayload>[],
): boolean {
  return hooks !== undefined && hooks.length > 0;
}

async function runHooks<TState, TPayload>(
  context: Context<TState>,
  actionName: HookMethod,
  hooks: HookMetadataArgs<TState, TPayload>[],
) {
  for (const hook of hooks) {
    const action: Function | undefined = (hook as any).instance[actionName];

    if (action !== undefined) {
      await (hook as any).instance[actionName](context, hook.payload);
    }
  }
}

// TODO(irustm): move to hooks function
function hasHooksAction<TState, TPayload>(
  actionName: string,
  hooks?: HookMetadataArgs<TState, TPayload>[],
): boolean {
  return !!(hooks &&
    hooks.find((hook) => (hook as any).instance[actionName] !== undefined));
}

export class App<TState> {
  private classes: ObjectKeyAny[] = [];
  private readonly metadata: MetadataArgsStorage<TState>;
  private routes: RouteMetadata[] = [];

  private staticConfig: StaticFilesConfig | undefined = undefined;
  private viewRenderConfig: ViewRenderConfig | undefined = undefined;
  private transformConfigMap?: TransformConfigMap | undefined = undefined;
  private globalErrorHandler?: (ctx: Context<TState>, error: Error) => void;

  private server: Server | undefined = undefined;

  constructor(settings: AppSettings) {
    this.metadata = getMetadataArgsStorage();

    registerAreas(this.metadata);
    registerControllers(
      this.metadata.controllers,
      this.classes,
      (route) => this.routes.push(route),
      settings.logging,
      settings.container
    );

    if (settings) {
      this.useStatic(settings.staticConfig);
      this.useViewRender(settings.viewRenderConfig);
    }
  }

  async listen(address: string | HTTPOptions = ":8000"): Promise<Server> {
    const server: Server = serve(address);
    this.server = server;

    console.log("Server start in", address);

    for await (const req of server) {
      const context = new Context<TState>(req);
      try {
        // Get middlewares in request
        const middlewares = this.metadata.middlewares.filter((m) =>
          m.route.test(context.request.url)
        );

        // Resolve every pre middleware
        for (const middleware of middlewares) {
          await middleware.target.onPreRequest(context);
        }

        if (context.response.isImmediately()) {
          req.respond(context.response.getRaw());
          continue;
        }

        // try getting static file
        if (
          this.staticConfig && await getStaticFile(context, this.staticConfig)
        ) {
          req.respond(context.response.getRaw());
          continue;
        }

        const action = getAction(
          this.routes,
          context.request.method,
          context.request.url,
        );

        if (action !== null) {
          const hooks = getHooksForAction(this.metadata.hooks, action);

          // try resolve hooks
          if (
            hasHooks(hooks) && await resolveHooks(context, "onPreAction", hooks)
          ) {
            continue;
          }

          // Get arguments in this action
          const args = await getActionParams(
            context,
            action,
            this.transformConfigMap,
          );

          try {
            // Get Action result from controller method
            context.response.result = await action.target[action.action](
              ...args,
            );
          } catch (error) {
            context.response.error = error;

            // try resolve hooks
            if (
              hasHooks(hooks) &&
              hasHooksAction("onCatchAction", hooks) &&
              await resolveHooks(context, "onCatchAction", hooks)
            ) {
              continue;
            } else {
              // Resolve every post middleware if error was not caught
              for (const middleware of middlewares) {
                await middleware.target.onPostRequest(context);
              }

              if (context.response.isImmediately()) {
                req.respond(context.response.getMergedResult());
                continue;
              }

              throw error;
            }
          }

          // try resolve hooks
          if (
            hasHooks(hooks) &&
            await resolveHooks(context, "onPostAction", hooks)
          ) {
            continue;
          }
        }

        if (context.response.isImmediately()) {
          req.respond(context.response.getMergedResult());
          continue;
        }

        // Resolve every post middleware
        for (const middleware of middlewares) {
          await middleware.target.onPostRequest(context);
        }

        if (context.response.isImmediately()) {
          req.respond(context.response.getMergedResult());
          continue;
        }

        if (context.response.result === undefined) {
          context.response.result = notFoundAction();

          req.respond(context.response.getMergedResult());
          continue;
        }

        req.respond(context.response.getMergedResult());
      } catch (error) {
        if (this.globalErrorHandler) {
          this.globalErrorHandler(context, error);

          if (context.response.isImmediately()) {
            req.respond(context.response.getMergedResult());
            continue;
          }
        }

        if (context.response.isImmediately()) {
          req.respond(context.response.getMergedResult());
          continue;
        }

        if (!(error instanceof HttpError)) {
          console.error(error);
        }

        req.respond(Content(error, error.httpCode || 500));
      }
    }

    return server;
  }

  public close(): void {
    if (this.server) {
      this.server.close();
    } else {
      console.warn("Server is not listening");
    }
  }

  public useStatic(config?: StaticFilesConfig): void {
    if (config && !this.staticConfig) {
      this.staticConfig = config;
    }
  }

  public useViewRender(config?: ViewRenderConfig): void {
    if (config && !this.viewRenderConfig) {
      this.viewRenderConfig = config;
      (global as any).viewRenderConfig = config;
    }
  }

  public useTransform(transform: TransformConfig): void {
    if (!this.transformConfigMap) {
      this.transformConfigMap = new Map();
    }

    this.transformConfigMap.set(transform.type, transform);
  }

  /**
  * Deprecate
  */
  public useCors(builder: CorsBuilder<TState>): void {
    this.metadata.middlewares.push({
      type: "middleware",
      target: builder,
      route: /\//,
    });
  }

  public use(route: RegExp, middleware: MiddlewareTarget<TState>): void {
    this.metadata.middlewares.push({
      type: "middleware",
      target: middleware,
      route,
    });
  }

  /**
   * Create one global error handler
   */
  public error(
    globalErrorHandler: (ctx: Context<TState>, error: Error) => void,
  ): void {
    this.globalErrorHandler = globalErrorHandler;
  }
}
