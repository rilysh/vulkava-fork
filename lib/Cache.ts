export default class Cache<T> extends Array<T> {
  public add(v: T): void {
    this.push(v);
  }

  public get each(): this {
    return this;
  }
}
