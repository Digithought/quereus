import { Scope } from "./scope.js";

/**
 * A Scope that aliases a parent scope.
 *
 * @param parent The parent scope, assumed to already be populated with symbols..
 */
export class AliasedScope extends Scope {
	constructor(parent: Scope, parentName: string, alias: string) {
		super(parent);
		const parentLower = parentName.toLowerCase();
		const aliasLower = alias.toLowerCase();
		parent.getSymbols().forEach(([symbolKey, getReference]) => {
			const split = symbolKey.split('.');
			if (split.some(part => part.toLowerCase() === parentLower)) {
				// Register both the alias and the original symbol
				this.registerSymbol(split.map(part => part === parentLower ? aliasLower : part).join('.'), getReference);
			}
			this.registerSymbol(symbolKey, getReference);
		});
	}
}