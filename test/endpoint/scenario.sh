#!/bin/bash
# Each step prints what happened; "Operation not permitted" / exit=126 means the kernel blocked it.
cd /work
echo "=== outside any agent: curl should work"
curl -s -o /dev/null -w "curl http=%{http_code}\n" https://example.com

echo "=== ELF agent 'claude'"
/opt/ag/claude -c '
  sleep ${AGENT_DELAY:-1}          # give effigentd time to load the policy (race window)
  ls / >/dev/null && echo "ls ok"
  cat .env >/dev/null && echo "read .env ok (should be alerted)"
  cat /etc/shadow >/dev/null 2>&1; echo "cat /etc/shadow exit=$? (1 = blocked by file_deny)"
  curl -s -o /dev/null https://example.com; echo "curl exit=$? (126 = blocked)"
  (exec 3<>/dev/tcp/1.1.1.1/80) && echo "raw tcp connect ok (should be reported)"
  /opt/mcp/mcp-server-github
'

echo "=== script agent (bash .../@anthropic-ai/claude-code/cli.js)"
bash /opt/nm/@anthropic-ai/claude-code/cli.js 'sleep ${AGENT_DELAY:-1}; curl -s -o /dev/null https://example.com; echo "curl exit=$? (126 = blocked)"; wget -q -O /dev/null https://example.com 2>/dev/null; echo "wget exit=$? (127 = not installed)"'

echo "=== launcher: effigentd run (agent acts immediately, no delay)"
effigentd run --agent claude-code -- bash -c 'curl -s -o /dev/null https://example.com; echo "launcher curl exit=$? (126 = blocked)"'
