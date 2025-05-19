export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
	return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
