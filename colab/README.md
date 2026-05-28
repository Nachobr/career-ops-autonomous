# Career-Ops — Google Colab LLM Server

Run a **free LLM** on Google Colab's GPU and use it with career-ops — no API keys, no local GPU required.

## Quick Start

1. Open `career_ops_llm_server.ipynb` in Google Colab (use the VS Code Colab extension or upload manually)
2. Set runtime to **GPU** (Runtime → Change runtime type → T4)
3. Get a free [ngrok auth token](https://dashboard.ngrok.com/get-started/your-authtoken)
4. Run all cells — you'll get a public URL
5. On your local machine:

```bash
node local-eval.mjs \
  --base https://xxxx-xx-xx.ngrok-free.app \
  --model Qwen/Qwen2.5-3B-Instruct \
  --file ./jds/your-job.txt
```

Or add to `.env` (recommended):
```env
LOCAL_LLM_BASE_URL=https://xxxx-xx-xx.ngrok-free.app
LOCAL_LLM_API_KEY=career-ops-colab
LOCAL_LLM_MODEL=Qwen/Qwen2.5-3B-Instruct
```

## Architecture

```
┌─────────────────────────────────────────────┐
│              Google Colab (Free GPU)         │
│                                             │
│   ┌──────────┐     ┌────────────────────┐   │
│   │  Qwen2.5 │────▶│  vLLM Server       │   │
│   │  7B      │     │  (OpenAI-compat)   │   │
│   └──────────┘     │  localhost:8000     │   │
│                    └────────┬───────────┘   │
│                             │               │
│                    ┌────────▼───────────┐   │
│                    │  ngrok tunnel      │   │
│                    └────────┬───────────┘   │
└─────────────────────────────┼───────────────┘
                              │ HTTPS
                              │
┌─────────────────────────────▼───────────────┐
│              Your Local Machine              │
│                                             │
│   node local-eval.mjs                       │
│     --base https://xxx.ngrok-free.app       │
│     --model Qwen/Qwen2.5-7B-Instruct       │
│     --file ./jds/my-job.txt                 │
└─────────────────────────────────────────────┘
```

## Available Models

| Model | VRAM | Quality | Best for |
|-------|------|---------|----------|
| `Qwen/Qwen2.5-7B-Instruct` | ~14 GB | ⭐⭐⭐⭐⭐ | T4 (15 GB) — best quality |
| `Qwen/Qwen2.5-3B-Instruct` | ~7 GB | ⭐⭐⭐⭐ | T4 with headroom |
| `google/gemma-2-9b-it` | ~18 GB | ⭐⭐⭐⭐⭐ | Colab Pro (A100) |
| `google/gemma-2-2b-it` | ~5 GB | ⭐⭐⭐ | Limited GPU |

## Notes

- **Free tier limits**: Colab free tier provides T4 GPUs with ~15 GB VRAM, sessions up to ~12 hours, may disconnect after ~90 min of inactivity
- **ngrok free tier**: 1 tunnel, no custom domains, sessions reset on disconnect
- **Persistence**: The model is cached in Colab's filesystem during the session but lost when the runtime disconnects
- **Quality**: The 7B model produces good evaluations. For best results, use the batch runner with Claude or the Gemini evaluator for production use
