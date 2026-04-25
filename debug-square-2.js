const square = require('square');
console.log('Square keys:', Object.keys(square));
console.log('Square default keys:', square.default ? Object.keys(square.default) : 'No default');
if (square.Client) console.log('Client found in square');
if (square.default && square.default.Client) console.log('Client found in square.default');
