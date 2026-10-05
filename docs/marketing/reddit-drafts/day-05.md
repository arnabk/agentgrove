# Day 5 — data

All chat history lives in one SQLite file in a .data folder inside the repo. You can open it with sqlite3 and grep your old conversations.

Every schema migration takes a snapshot first, and there's a one-line restore command. I added that after a migration ate my own chat history once.
