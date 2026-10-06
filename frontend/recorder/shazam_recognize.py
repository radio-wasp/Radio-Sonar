#!/usr/bin/env python3
import asyncio
import json
import os
import sys

async def recognize_audio(file_path):
    try:
        from shazamio import Shazam
    except ImportError:
        print(json.dumps({"match": False, "error": "shazamio library not installed"}))
        return

    if not os.path.exists(file_path):
        print(json.dumps({"match": False, "error": f"File not found: {file_path}"}))
        return

    try:
        shazam = Shazam()
        out = await shazam.recognize(file_path)
        track = out.get('track') if isinstance(out, dict) else None
        
        if track and track.get('title') and track.get('subtitle'):
            images = track.get('images', {})
            albumart = images.get('coverarthq') or images.get('coverart') or images.get('background')
            genres = track.get('genres', {})
            
            result = {
                "match": True,
                "title": track.get('title'),
                "artist": track.get('subtitle'),
                "albumart": albumart,
                "genre": genres.get('primary'),
                "shazamId": track.get('key'),
                "url": track.get('url'),
                "score": 0.99
            }
            print(json.dumps(result))
        else:
            print(json.dumps({"match": False}))
    except Exception as e:
        print(json.dumps({"match": False, "error": str(e)}))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"match": False, "error": "No audio file argument"}))
        sys.exit(0)
    
    file_path = sys.argv[1]
    asyncio.run(recognize_audio(file_path))
