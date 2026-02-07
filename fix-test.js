const fs = require('fs');
const path = 'packages/quereus/test/logic/06.1-string-functions.sqllogic';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(
  "reverse('')\":null",
  "reverse('')\":\"\""
);
content = content.replace(
  '-- reverse of empty string',
  '-- reverse of empty string returns empty string'
);
fs.writeFileSync(path, content);
console.log('Fixed');
