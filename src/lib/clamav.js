'use strict';
// ClamAV, spoken directly. clamd's INSTREAM command is a short binary protocol
// over a socket, so this is thirty lines of node:net rather than a fifth
// dependency — consistent with a repo that has four and a history of native
// bindings breaking Linux deploys.
//
// The protocol, in full:
//   → "zINSTREAM\0"
//   → repeated: <uint32be length><that many bytes>
//   → <uint32be 0>            (end of stream)
//   ← "stream: OK\0"  |  "stream: <Signature> FOUND\0"  |  "… ERROR\0"
//
// The `z` prefix is the NUL-terminated command variant. The newline variant
// (`n`) exists too; `z` is used here because it does not care what is in the
// data it is framing.
const net = require('node:net');
const { CLAMAV } = require('../config');

// The EICAR test string: not malware, but every scanner on earth is required to
// flag it. It is the only way to prove the wiring works without handling a real
// sample. Assembled from pieces so this source file does not itself trip a
// scanner reading the repo.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', 'STANDARD', 'ANTIVIRUS',
               'TEST', 'FILE!$H+H*'].join('-');

const scannerConfigured = () => !!CLAMAV.address;

// clamd answers with one line. `stream: OK` and `stream: <sig> FOUND` are the
// two that mean the scan ran; anything ending ERROR means it did not. The
// size-limit case is pulled out separately because it is the one ERROR that is
// routine rather than a fault — a 60 MB video is past clamd's default
// StreamMaxLength and is still a perfectly ordinary thing for a customer to
// send.
function parseReply(text) {
  const line = String(text || '').replace(/\0/g, '').trim();
  if (!line) return { status: 'error', signature: 'clamd closed the connection without answering' };
  if (/size limit exceeded/i.test(line)) return { status: 'oversize', signature: line };
  if (/\bOK$/.test(line)) return { status: 'clean', signature: null };
  const found = line.match(/^stream:\s*(.+?)\s+FOUND$/);
  if (found) return { status: 'infected', signature: found[1] };
  return { status: 'error', signature: line };
}

// host:port or a unix socket path. A trailing colon-then-digits is the only
// thing that distinguishes them, and a real socket path never ends that way.
const connectOptions = addr => {
  const m = /^(.+):(\d+)$/.exec(addr);
  return m ? { host: m[1], port: Number(m[2]) } : { path: addr };
};

// Never throws and never rejects. Every caller is a save path that has to turn
// the outcome into a database row and a sentence for an operator, and an
// exception here would be indistinguishable at the catch site from a clean
// scan — which is the one failure mode this whole module exists to prevent.
function scanBuffer(buf) {
  if (!scannerConfigured()) return Promise.resolve({ status: 'skipped', signature: null });

  return new Promise(resolve => {
    let settled = false;
    const done = r => { if (!settled) { settled = true; sock.destroy(); resolve(r); } };

    const sock = net.connect(connectOptions(CLAMAV.address));
    sock.setTimeout(CLAMAV.timeoutMs);

    let reply = '';
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      // 64 KiB is clamd's own preferred chunk size. Larger chunks are legal but
      // the daemon buffers each one whole, and this file may be 100 MB.
      for (let i = 0; i < buf.length; i += 65536) {
        const chunk = buf.subarray(i, i + 65536);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));   // uint32be 0 — end of stream
    });

    sock.on('data',  d => { reply += d.toString(); });
    // Both, because a daemon that answers and hangs up may fire either first
    // and `done` is idempotent. A close with nothing received parses as the
    // error it is.
    sock.on('end',   () => done(parseReply(reply)));
    sock.on('close', () => done(parseReply(reply)));
    sock.on('timeout', () => done({ status: 'error', signature: `clamd timed out after ${CLAMAV.timeoutMs}ms` }));
    sock.on('error', e => done({ status: 'error', signature: `clamd unreachable at ${CLAMAV.address}: ${e.message}` }));
  });
}

module.exports = { scanBuffer, parseReply, scannerConfigured, EICAR };
