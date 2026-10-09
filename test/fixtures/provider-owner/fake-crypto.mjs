// Stands in for `TreziSecrets --crypto encrypt|decrypt`: bytes on stdin, bytes on stdout.
// "Encrypts" by prefixing a marker and refuses to decrypt anything without it; a key
// containing "locked" fails to encrypt (the locked-Keychain path).
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = Buffer.concat(chunks)
const operation = process.argv[process.argv.indexOf('--crypto') + 1]
if (operation === 'encrypt' && !input.includes('locked')) process.stdout.write(Buffer.concat([Buffer.from('enc:'), input]))
else if (operation === 'decrypt' && input.subarray(0, 4).toString() === 'enc:') process.stdout.write(input.subarray(4))
else {
  process.stderr.write(`cannot ${operation}\n`)
  process.exit(1)
}
