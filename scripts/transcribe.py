#!/usr/bin/env python3
"""Loom transcription via MLX Whisper (shares the medium model already cached
   for the other project — no extra model download). Auto-detects language
   (English / Cantonese). Usage: python transcribe.py <audio-file>
   Only the transcript text goes to stdout; all library chatter goes to stderr."""
import sys
import contextlib
import mlx_whisper

MODEL = "mlx-community/whisper-medium-mlx"

def main():
    if len(sys.argv) < 2:
        return
    # mlx_whisper prints "Detected language: ..." to stdout — send it to stderr
    with contextlib.redirect_stdout(sys.stderr):
        r = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=MODEL, verbose=False)
    sys.stdout.write((r.get("text") or "").strip())

if __name__ == "__main__":
    main()
