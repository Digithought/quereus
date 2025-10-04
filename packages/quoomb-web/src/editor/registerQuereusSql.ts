import type { Monaco } from '@monaco-editor/react';

const LANGUAGE_ID = 'quereus-sql';

const DECLARATIVE_KEYWORDS = [
	'declare',
	'diff',
	'apply',
	'explain',
	'version',
	'seed',
	'schema'
];

const DDL_KEYWORDS = [
	'create',
	'alter',
	'drop',
	'if',
	'exists',
	'table',
	'view',
	'index',
	'trigger'
];

const DML_KEYWORDS = [
	'with',
	'recursive',
	'select',
	'insert',
	'update',
	'delete',
	'values',
	'into'
];

const QUERY_KEYWORDS = [
	'from',
	'where',
	'group',
	'by',
	'having',
	'order',
	'limit',
	'offset',
	'union',
	'intersect',
	'except'
];

const JOIN_KEYWORDS = [
	'join',
	'inner',
	'left',
	'right',
	'outer',
	'cross',
	'full',
	'on',
	'using'
];

const CONSTRAINT_KEYWORDS = [
	'constraint',
	'primary',
	'unique',
	'foreign',
	'check',
	'references',
	'match',
	'deferrable',
	'initially',
	'cascade',
	'restrict',
	'set'
];

const BOOLEAN_KEYWORDS = [
	'and',
	'or',
	'not',
	'xor',
	'like',
	'between',
	'exists',
	'is',
	'null',
	'no',
	'action'
];

const OTHER_KEYWORDS = [
	'as',
	'distinct',
	'all',
	'case',
	'when',
	'then',
	'else',
	'end',
	'collate',
	'default',
	'generated',
	'always',
	'stored',
	'virtual',
	'if',
	'add',
	'rename',
	'ignore',
	'replace',
	'over',
	'partition',
	'rows',
	'range',
	'unbounded',
	'preceding',
	'following',
	'current',
	'temp',
	'temporary'
];

const KEYWORDS = [
	...DECLARATIVE_KEYWORDS,
	...DDL_KEYWORDS,
	...DML_KEYWORDS,
	...QUERY_KEYWORDS,
	...JOIN_KEYWORDS,
	...CONSTRAINT_KEYWORDS,
	...BOOLEAN_KEYWORDS,
	...OTHER_KEYWORDS
];

const OPERATORS = [
	'=',
	'==',
	'!=',
	'<>',
	'<=',
	'>=',
	'<',
	'>',
	'\+',
	'-',
	'\*',
	'/',
	'%',
	'\|\|'
];

const keywordToken = new Map<string, string>([
	...DECLARATIVE_KEYWORDS.map((keyword) => [keyword, 'keyword.declarative'] as const),
	...DDL_KEYWORDS.map((keyword) => [keyword, 'keyword.ddl'] as const),
	...DML_KEYWORDS.map((keyword) => [keyword, 'keyword.dml'] as const),
	...CONSTRAINT_KEYWORDS.map((keyword) => [keyword, 'keyword.constraint'] as const),
	...JOIN_KEYWORDS.map((keyword) => [keyword, 'keyword.join'] as const),
	...QUERY_KEYWORDS.map((keyword) => [keyword, 'keyword.query'] as const),
	...BOOLEAN_KEYWORDS.map((keyword) => [keyword, 'keyword.boolean'] as const),
	...OTHER_KEYWORDS.map((keyword) => [keyword, 'keyword.other'] as const)
]);

const getKeywordCases = (): Record<string, string> => {
	const result: Record<string, string> = {};
	for (const [keyword, token] of keywordToken.entries()) {
		result[keyword] = token;
	}
	return result;
};

let isRegistered = false;

export const registerQuereusSql = (monaco: Monaco): void => {
	if (isRegistered) {
		return;
	}

	const alreadyRegistered = monaco.languages
		.getLanguages()
		.some((language) => language.id === LANGUAGE_ID);

	if (!alreadyRegistered) {
		monaco.languages.register({ id: LANGUAGE_ID });
	}

	monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
		comments: {
			lineComment: '--',
			blockComment: ['/*', '*/']
		},
		brackets: [
			['(', ')'],
			['[', ']'],
			['{', '}']
		],
		autoClosingPairs: [
			{ open: '(', close: ')' },
			{ open: '[', close: ']' },
			{ open: '{', close: '}' },
			{ open: '"', close: '"', notIn: ['string'] },
			{ open: '\'', close: '\'' }
		],
		surroundingPairs: [
			{ open: '(', close: ')' },
			{ open: '[', close: ']' },
			{ open: '{', close: '}' },
			{ open: '"', close: '"' },
			{ open: '\'', close: '\'' }
		]
	});

	monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
		ignoreCase: true,
		defaultToken: '',
		brackets: [
			{ open: '(', close: ')', token: 'delimiter.parenthesis' },
			{ open: '[', close: ']', token: 'delimiter.square' },
			{ open: '{', close: '}', token: 'delimiter.curly' }
		],
		keywords: KEYWORDS,
		operators: OPERATORS,
		tokenizer: {
			root: [
				{ include: '@whitespace' },
				[/0x[0-9a-f]+/, 'number' ],
				[/\d+(?:\.\d+)?/, 'number' ],
				[/"([^""\\]|\\.)*"/, 'identifier' ],
				[/'/, { token: 'string', next: '@string' }],
				[/[;,.]/, 'delimiter' ],
				[/[()\[\]{}]/, '@brackets' ],
				[/[<>=!%&+\-*/|~^]/, 'operator' ],
				[/[a-zA-Z_][\w$#@]*/, {
					cases: {
						'@keywords': {
							cases: getKeywordCases()
						},
						'@default': 'identifier'
					}
				}]
			],
			string: [
				[/[^']+/, 'string' ],
				[/''/, 'string.escape' ],
				[/'/, { token: 'string', next: '@pop' }]
			],
			whitespace: [
				[/\s+/, 'white' ],
				[/--.*$/, 'comment' ],
				[/\/\*/, { token: 'comment', next: '@comment' }]
			],
			comment: [
				[/[^*/]+/, 'comment' ],
				[/\*\//, { token: 'comment', next: '@pop' }],
				[/[*/]/, 'comment' ]
			]
		}
	});

	isRegistered = true;
};

