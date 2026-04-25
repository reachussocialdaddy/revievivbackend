const square = require('square');
console.log('Square keys:', Object.keys(square));
if (square.Client) {
    console.log('Client exists');
} else {
    console.log('Client is undefined');
}
