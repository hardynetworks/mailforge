// Fake recipient mail server for local testing: stores messages in /tmp/fakemx/*.eml, rejects bad@*
const { SMTPServer } = require('smtp-server'); const fs = require('fs');
fs.mkdirSync('/tmp/fakemx', { recursive: true });
let n = 0;
new SMTPServer({
  authOptional: true, disabledCommands: ['STARTTLS'],
  onRcptTo(a, s, cb) { if (a.address.startsWith('bad@')) { const e = new Error('550 5.1.1 User unknown'); e.responseCode = 550; return cb(e); } cb(); },
  onData(stream, session, cb) { const f = `/tmp/fakemx/${++n}-${session.envelope.rcptTo[0].address}.eml`; const w = fs.createWriteStream(f);
    fs.writeFileSync(f + '.env', JSON.stringify(session.envelope)); stream.pipe(w); stream.on('end', () => cb(null, 'OK queued as ' + n)); },
}).listen(1025, () => console.log('fake mx on 1025'));
