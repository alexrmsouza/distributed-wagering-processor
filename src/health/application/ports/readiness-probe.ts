export interface ReadinessProbe {
  check(): Promise<void>;
  onModuleDestroy?(): void | Promise<void>;
}
