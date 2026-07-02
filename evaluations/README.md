# Agent evaluations

`pnpm eval` runs deterministic policy and behavior scenarios separately from unit
tests. The suite covers:

- correct tool selection and argument construction;
- malformed/illegal move recovery;
- ambiguous notation without silent guessing;
- stale revisions and wrong-game access;
- conversation continuity through native function calls;
- live human-game assistance denial;
- tool/model failure normalization;
- grounded review evidence and bounded critical moments;
- consistent typed events for client rendering.

Add a regression case before fixing any production agent failure. Evaluations use
fake models/providers and never call OpenAI, Lichess, or Stockfish over the network.
Production prompt/model candidates must pass this suite plus a separately versioned
human-rated explanation dataset before rollout.

