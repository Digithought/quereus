import { expect } from 'chai';
import { Database, registerPlugin } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import stringFunctionsPlugin from '../string-functions/index.js';
import customCollationsPlugin from '../custom-collations/index.js';
import comprehensiveDemoPlugin from '../comprehensive-demo/index.js';
import jsonTablePlugin from '../json-table/index.js';

async function all(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(row);
	}
	return rows;
}

describe('String Functions Plugin', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await registerPlugin(db, stringFunctionsPlugin);
	});

	afterEach(async () => {
		await db.close();
	});

	it('reverse() reverses a string', async () => {
		const row = await db.get('select reverse(\'hello\') as r');
		expect(row!.r).to.equal('olleh');
	});

	it('reverse() returns null for null input', async () => {
		const row = await db.get('select reverse(null) as r');
		expect(row!.r).to.be.null;
	});

	it('title_case() converts to title case', async () => {
		const row = await db.get('select title_case(\'hello world\') as r');
		expect(row!.r).to.equal('Hello World');
	});

	it('title_case() returns null for null input', async () => {
		const row = await db.get('select title_case(null) as r');
		expect(row!.r).to.be.null;
	});

	it('repeat() repeats a string N times', async () => {
		const row = await db.get('select repeat(\'ha\', 3) as r');
		expect(row!.r).to.equal('hahaha');
	});

	it('repeat() returns empty string for count 0', async () => {
		const row = await db.get('select repeat(\'ha\', 0) as r');
		expect(row!.r).to.equal('');
	});

	it('repeat() returns null for null inputs', async () => {
		const r1 = await db.get('select repeat(null, 3) as r');
		expect(r1!.r).to.be.null;
		const r2 = await db.get('select repeat(\'ha\', null) as r');
		expect(r2!.r).to.be.null;
	});

	it('slugify() converts text to URL-friendly slug', async () => {
		const row = await db.get('select slugify(\'Hello World!\') as r');
		expect(row!.r).to.equal('hello-world');
	});

	it('slugify() handles multiple spaces', async () => {
		const row = await db.get('select slugify(\'  Multiple   Spaces  \') as r');
		expect(row!.r).to.equal('multiple-spaces');
	});

	it('word_count() counts words', async () => {
		const row = await db.get('select word_count(\'Hello beautiful world\') as r');
		expect(row!.r).to.equal(3);
	});

	it('word_count() returns 0 for empty string', async () => {
		const row = await db.get('select word_count(\'\') as r');
		expect(row!.r).to.equal(0);
	});

	it('word_count() returns 0 for null', async () => {
		const row = await db.get('select word_count(null) as r');
		expect(row!.r).to.equal(0);
	});

	it('str_concat() concatenates strings', async () => {
		const row = await db.get('select str_concat(\'Hello\', \' \', \'World\', \'!\') as r');
		expect(row!.r).to.equal('Hello World!');
	});

	it('str_concat() ignores null values', async () => {
		const row = await db.get('select str_concat(\'A\', null, \'B\') as r');
		expect(row!.r).to.equal('AB');
	});
});

describe('Custom Collations Plugin', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await registerPlugin(db, customCollationsPlugin);
	});

	afterEach(async () => {
		await db.close();
	});

	it('NUMERIC collation sorts numbers naturally', async () => {
		await db.exec('create table files (name text)');
		await db.exec('insert into files values (\'file10.txt\')');
		await db.exec('insert into files values (\'file2.txt\')');
		await db.exec('insert into files values (\'file1.txt\')');

		const rows = await all(db, 'select name from files order by name collate NUMERIC');
		expect(rows.map(r => r.name)).to.deep.equal(['file1.txt', 'file2.txt', 'file10.txt']);
	});

	it('LENGTH collation sorts by string length', async () => {
		await db.exec('create table words (w text)');
		await db.exec('insert into words values (\'cat\')');
		await db.exec('insert into words values (\'a\')');
		await db.exec('insert into words values (\'hello\')');

		const rows = await all(db, 'select w from words order by w collate LENGTH');
		expect(rows.map(r => r.w)).to.deep.equal(['a', 'cat', 'hello']);
	});

	it('REVERSE collation sorts in reverse order', async () => {
		await db.exec('create table vals (v text)');
		await db.exec('insert into vals values (\'a\')');
		await db.exec('insert into vals values (\'b\')');
		await db.exec('insert into vals values (\'c\')');

		const rows = await all(db, 'select v from vals order by v collate REVERSE');
		expect(rows.map(r => r.v)).to.deep.equal(['c', 'b', 'a']);
	});

	it('ALPHANUM collation handles mixed text and numbers', async () => {
		await db.exec('create table items (name text)');
		await db.exec('insert into items values (\'item20\')');
		await db.exec('insert into items values (\'item3\')');
		await db.exec('insert into items values (\'item1\')');

		const rows = await all(db, 'select name from items order by name collate ALPHANUM');
		expect(rows.map(r => r.name)).to.deep.equal(['item1', 'item3', 'item20']);
	});
});

describe('Comprehensive Demo Plugin', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await registerPlugin(db, comprehensiveDemoPlugin);
	});

	afterEach(async () => {
		await db.close();
	});

	describe('key_value_store virtual table', () => {
		it('creates a table and inserts/queries rows', async () => {
			await db.exec('create table kv (key text primary key, value text) using key_value_store');
			await db.exec('insert into kv values (\'greeting\', \'hello\')');

			const rows = await all(db, 'select * from kv');
			expect(rows).to.have.length(1);
			expect(rows[0].value).to.equal('hello');
		});

		it('supports delete', async () => {
			await db.exec('create table kv (key text primary key, value text) using key_value_store');
			await db.exec('insert into kv values (\'a\', \'1\')');
			await db.exec('delete from kv where key = \'a\'');

			const rows = await all(db, 'select * from kv');
			expect(rows).to.have.length(0);
		});

		it('supports update', async () => {
			await db.exec('create table kv (key text primary key, value text) using key_value_store');
			await db.exec('insert into kv values (\'a\', \'old\')');
			await db.exec('update kv set value = \'new\' where key = \'a\'');

			const rows = await all(db, 'select * from kv');
			expect(rows).to.have.length(1);
			expect(rows[0].value).to.equal('new');
		});
	});

	describe('math_round_to function', () => {
		it('rounds to specified precision', async () => {
			const row = await db.get('select math_round_to(3.14159, 2) as r');
			expect(row!.r).to.equal(3.14);
		});

		it('returns null for null inputs', async () => {
			const row = await db.get('select math_round_to(null, 2) as r');
			expect(row!.r).to.be.null;
		});
	});

	describe('hex_to_int function', () => {
		it('converts hex to integer', async () => {
			const row = await db.get('select hex_to_int(\'FF\') as r');
			expect(row!.r).to.equal(255);
		});

		it('handles 0x prefix', async () => {
			const row = await db.get('select hex_to_int(\'0xFF\') as r');
			expect(row!.r).to.equal(255);
		});

		it('returns null for null', async () => {
			const row = await db.get('select hex_to_int(null) as r');
			expect(row!.r).to.be.null;
		});
	});

	describe('int_to_hex function', () => {
		it('converts integer to hex', async () => {
			const row = await db.get('select int_to_hex(255) as r');
			expect(row!.r).to.equal('0xFF');
		});

		it('returns null for non-integer', async () => {
			const row = await db.get('select int_to_hex(3.14) as r');
			expect(row!.r).to.be.null;
		});
	});

	describe('UNICODE_CI collation', () => {
		it('sorts case-insensitively', async () => {
			await db.exec('create table words (w text)');
			await db.exec('insert into words values (\'Banana\')');
			await db.exec('insert into words values (\'apple\')');
			await db.exec('insert into words values (\'Cherry\')');

			const rows = await all(db, 'select w from words order by w collate UNICODE_CI');
			expect(rows.map(r => r.w)).to.deep.equal(['apple', 'Banana', 'Cherry']);
		});
	});
});

describe('JSON Table Plugin', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await registerPlugin(db, jsonTablePlugin);
	});

	afterEach(async () => {
		await db.close();
	});

	it('reads inline JSON array', async () => {
		await db.exec('create table data (value text) using json_table(inline = \'["a","b","c"]\')');

		const rows = await all(db, 'select * from data');
		expect(rows).to.have.length(3);
		expect(rows.map(r => r.value)).to.deep.equal(['a', 'b', 'c']);
	});

	it('reads inline JSON objects with multiple columns', async () => {
		await db.exec(`create table data (name text, age integer null) using json_table(inline = '[{"name":"Alice","age":30},{"name":"Bob","age":25}]')`);

		const rows = await all(db, 'select * from data');
		expect(rows).to.have.length(2);
		expect(rows[0].name).to.equal('Alice');
	});

	it('handles empty inline JSON array', async () => {
		await db.exec('create table data (value text) using json_table(inline = \'[]\')');

		const rows = await all(db, 'select * from data');
		expect(rows).to.have.length(0);
	});

	it('handles invalid inline JSON gracefully', async () => {
		await db.exec('create table data (value text) using json_table(inline = \'not json\')');

		const rows = await all(db, 'select * from data');
		expect(rows).to.have.length(0);
	});

	it('is read-only', async () => {
		await db.exec('create table data (value text) using json_table(inline = \'["a"]\')');

		try {
			await db.exec('insert into data values (\'x\')');
			expect.fail('should have thrown');
		} catch (e) {
			expect((e as Error).message).to.include('read-only');
		}
	});
});
