import {writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
const {HOST_PROTOCOL_V1_JSON_SCHEMA}=createRequire(import.meta.url)('../packages/protocol/dist/index.js')
await writeFile(new URL('../packages/protocol/schema/host-protocol-v1.schema.json',import.meta.url),JSON.stringify(HOST_PROTOCOL_V1_JSON_SCHEMA,null,2)+'\n')
