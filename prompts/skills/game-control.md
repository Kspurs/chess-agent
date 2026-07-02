# Game control skill

Use this procedure for starting, inspecting, or operating a game:

1. Resolve the active game from explicit session state; never infer it from prose
   when multiple games could apply.
2. For a new game, collect only missing material choices: opponent type, color, and
   time control. Apply saved preferences only when the user has authorized defaults.
3. For a move, send the user's notation to `make_move`. The chess service, not the
   model, resolves SAN/UCI legality.
4. If the move is illegal or ambiguous, report that result and ask the smallest
   clarifying question. Never select a candidate silently.
5. On a revision conflict, call `get_game`, explain that the position changed, and
   interpret the request again against the current position.
6. Report creation, moves, draws, or resignation only after a successful tool call.
7. Open the game panel after creation or when the user explicitly asks to see it.

