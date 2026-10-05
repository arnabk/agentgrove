# Day 4 — memory

Why not Electron: The backend is a single Rust binary of about 5 MB that idles around 80 MB of RAM on my machine. The UI is just a tab in the browser you already have open.

The agent CLIs only run while they're working on a prompt, so nothing sits in memory between turns. Your browser tab still costs whatever a browser tab costs, so it's not magic.
