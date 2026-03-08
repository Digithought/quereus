#!/usr/bin/env node

const { execSync } = require('child_process');
const { join } = require('path');

const rootDir = join(__dirname, '..');
const packageName = process.argv[2];

if (!packageName) {
	console.error('Usage: node scripts/publish-package.js <package-name>');
	process.exit(1);
}

const packageDir = join(rootDir, 'packages', packageName);

try {
	process.chdir(packageDir);
	
	console.log(`Publishing ${packageName}`);

	execSync('yarn clean', { stdio: 'inherit' });
	execSync('yarn build', { stdio: 'inherit' });
	execSync('yarn npm publish --access public', { stdio: 'inherit' });
} catch (error) {
	console.error(`Failed to publish ${packageName}:`, error.message);
	process.exit(1);
}
