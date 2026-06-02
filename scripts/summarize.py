#!/usr/bin/env python3
"""Summarize/clarify a raw note via a small local MLX LLM (private, no API).
   Reads note text from stdin; writes ONLY the rewritten note to stdout."""
import sys, contextlib
from mlx_lm import load, generate

MODEL = "mlx-community/Qwen2.5-3B-Instruct-4bit"
SYS = ("You rewrite a person's raw, rambling note into a clear, concise version that "
       "captures what they actually mean. Keep the SAME language as the note (English or "
       "Cantonese/Chinese). Output ONLY the rewritten note — no preamble, no quotes, no explanation.")

def main():
    text = sys.stdin.read().strip()
    if not text:
        return
    with contextlib.redirect_stdout(sys.stderr):  # keep mlx chatter off stdout
        model, tok = load(MODEL)
        msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": text}]
        prompt = tok.apply_chat_template(msgs, add_generation_prompt=True)
        out = generate(model, tok, prompt, max_tokens=300, verbose=False)
    sys.stdout.write((out or "").strip())

if __name__ == "__main__":
    main()
