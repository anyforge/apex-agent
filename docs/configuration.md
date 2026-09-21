# Configuration

All config lives in `~/.apex-agent/config.yaml` (auto-generated on first run) and `~/.apex-agent/.env` (credentials).

```bash
apex config                 # show effective config (merged defaults + your file)
apex config set <key> <value>   # set a dot-path value, comments preserved
apex migrate                # migrate to the current schema version
```

## Top-level shape

```yaml
schema_version: 2      # migration key — do not edit
lang: en               # en | zh
model: { ... }         # effective model (provider + name + model + params)
providers: [ ... ]     # model provider list (multi-provider, each with models)
workspace: { ... }     # workspace root + permissions
agent: { ... }         # all internal subsystems
gateway: { ... }       # messaging platform adapters
theme: { cli, tui }    # UI theme
logging: { ... }       # log file location
```

## Model

```yaml
model:
  provider: openai         # openai | anthropic | mock
  providerName: DeepSeek   # reference into providers[].name
  model: deepseek-chat     # the model in use
  baseUrl: ""              # optional override (else merged from provider)
  temperature: 0.7
  topP: 1.0
  reasoningEffort: medium  # minimal | low | medium | high
  maxTokens: 16000
```

The `model` block holds only `provider + providerName + model`; `baseUrl` / `apiKey` / params merge from the matching `providers[]` entry by `providerName`. The api key is never stored here — put it in `.env`.

```yaml
providers:
  - name: DeepSeek
    provider: openai
    protocol: chat          # chat | responses
    baseUrl: https://api.deepseek.com/v1
    apiKey: ""              # or use OPENAI_API_KEY env var
    models: [deepseek-chat, deepseek-reasoner]
    temperature: 0.7
    maxTokens: 16384
```

## Workspace

```yaml
workspace:
  dir: ~/.apex-agent/workspaces   # workspace root
  default: default                 # default workspace name
  # grants:                        # optional out-of-sandbox path grants
  #   - path: ~/.apex-agent/tmp
```

## Agent internals

```yaml
agent:
  maxSteps: 90              # micro-loop max steps
  maxRounds: 5              # macro-loop (OODA) max rounds
  loopDetection:
    repeatThreshold: 3      # identical tool calls in a row → runaway loop

  guardrails:               # no-progress / repeated-failure defenses
    exactFailureWarnAfter: 2
    exactFailureBlockAfter: 5
    sameToolFailureWarnAfter: 3
    sameToolFailureHaltAfter: 8
    noProgressWarnAfter: 2
    noProgressBlockAfter: 5

  compaction:               # context-window compaction
    enabled: true
    contextLength: 128000
    thresholdPercent: 0.50
    smallCtxThresholdPercent: 0.75
    protectFirstN: 3
    protectLastN: 20
    summaryMaxRatio: 0.05
    bodyMaxChars: 6000

  evolution:                # offline memory distillation (staggered, turn-based)
    enabled: true
    nudgeInterval: 10       # facts + foresight: every N user turns
    profileInterval: 20     # profile: every N user turns
    caseInterval: 15        # agent case: every N user turns
    skillReviewInterval: 15 # skill review: every N tool iterations

  memory:
    enabled: true

  approval:                 # high-risk action approval
    mode: manual            # off | smart | manual

  verdict:                  # verification toggle
    enabled: true           # false = skip verify but report unverified (never fake ok)
```

## Gateway (messaging)

```yaml
gateway:
  feishu:
    enabled: false          # enable → gateway run starts the Feishu long connection
    connectionMode: websocket  # websocket | webhook (webhook not yet implemented)
    domain: feishu          # feishu (domestic) | lark (international)
    appId: ""               # or FEISHU_APP_ID env var
    appSecret: ""           # or FEISHU_APP_SECRET env var
```

## Logging

```yaml
logging:
  dir: ~/.apex-agent/logs
  file: apex                # base name; rolled with date suffix
```

## `apex config set` examples

```bash
apex config set lang zh
apex config set model.provider openai
apex config set model.model deepseek-chat
apex config set gateway.feishu.enabled true
apex config set agent.approval.mode smart
apex config set agent.compaction.thresholdPercent 0.60
```

Values are auto-typed: `true`/`false` → boolean, `123` → number, otherwise string.
