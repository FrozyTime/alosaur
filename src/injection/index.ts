import "./reflect.ts";

export {
  DependencyContainer,
  Lifecycle,
  RegistrationOptions,
  
} from "./types/index.ts";
export * from "./decorators/index.ts";
export * from "./factories/index.ts";
export * from "./providers/index.ts";
export { delay } from "./lazy-helpers.ts";
export { instance as container, InternalDependencyContainer } from "./dependency-container.ts";
