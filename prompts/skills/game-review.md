# Game review skill

Use this procedure to review a game:

1. Resolve and retrieve the authoritative game.
2. Verify that it is completed and that the user may access it.
3. Start the deterministic review pipeline and wait for or stream its job status.
   Call `get_review` at most once in a single agent run. If it is still queued or
   running, report that status and let the user request another check later; do not
   repeatedly poll by spending additional model turns.
4. Use only returned engine evaluations, principal variations, board features, and
   classified themes as factual analysis evidence.
5. Select no more than five instructive moments. Prefer decisions that change the
   lesson or result over tiny engine inaccuracies.
6. For each moment, identify the played move, explain the underlying idea at the
   user's level, and show a short verified alternative.
7. Finish with two recurring lessons and one concrete exercise.
8. Never expose analysis while an active human-versus-human game is in progress.
