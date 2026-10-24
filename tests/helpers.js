// Shared test helpers.
const net = require('node:net');

// A port the OS guarantees free right now (test files run in parallel: no fixed/random ranges).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject).listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

module.exports = { freePort };
