import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { HOST_PROTOCOL_V1_JSON_SCHEMA } = require('../packages/protocol/dist/index.js')
const published = JSON.parse(await readFile(new URL('../packages/protocol/schema/host-protocol-v1.schema.json', import.meta.url), 'utf8'))
assert.deepEqual(published, HOST_PROTOCOL_V1_JSON_SCHEMA, 'The Android JSON Schema must match the built Host protocol definition.')
console.log('Protocol JSON Schema matches the Host definition.')
