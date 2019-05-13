import { ControllerMetadataArgs } from './controller.ts';
/**
* Storage all metadatas read from decorators.
*/
export class MetadataArgsStorage {
  /**
   * Register areas
   */
  areas: any[] = [];
  /**
   * Registered controller metadata args.
   */
  controllers: ControllerMetadataArgs[] = [];
  /**
   * Registered actions.
   */
  actions: any[] = [];
  
  /**
   * Registered params.
   */
  params: any[] = [];
}