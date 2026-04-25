export class Singletons {
  private static instances = new Map<string, unknown>()

  static computeIfAbsent<T>(key: string, factory: () => T): T {
    if (!this.instances.has(key)) {
      this.instances.set(key, factory())
    }
    return this.instances.get(key) as T
  }

  static set<T>(key: string, instance: T): void {
    this.instances.set(key, instance)
  }

  static clear(): void {
    this.instances.clear()
  }
}
