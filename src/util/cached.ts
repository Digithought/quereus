/** Minimalistic caching utility. */
export class Cached<T> {
	private cachedValue: T | undefined;

	constructor(private readonly compute: () => T) {}

	get value(): T {
		if (!this.cachedValue) {
			this.cachedValue = this.compute();
		}
		return this.cachedValue;
	}

	clear() {
		this.cachedValue = undefined;
	}
}
