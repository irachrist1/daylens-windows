// Stand-in for the native capture helper: prints the ndjson lines passed via
// DAYLENS_FAKE_HELPER_EVENTS (a JSON array of objects), then stays alive
// until "shutdown" arrives on stdin, like the real helper.
const events = JSON.parse(process.env.DAYLENS_FAKE_HELPER_EVENTS ?? '[]')
for (const event of events) {
  process.stdout.write(JSON.stringify(event) + '\n')
}
process.stdout.write('not json at all\n')

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (String(chunk).includes('shutdown')) process.exit(0)
})
setTimeout(() => process.exit(0), 30_000)
