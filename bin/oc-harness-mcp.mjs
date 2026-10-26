#!/usr/bin/env node
// Start the read-only MCP server over stdio.
import { serveStdio } from "../src/mcp/server.mjs"

await serveStdio()
