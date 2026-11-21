# Sokoban solver

A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.

## Idea

Each level is a hallway with rooms off it, and a box pushed out of a room
can never be pushed back — so every room is an independent puzzle, and the
level's push-optimal count is the sum of its rooms' optima. The solver
cuts the hallway's dead squares out of the floor, finds each room as a
connected part, and solves every room on its own with a breadth-first
search over pushes. States expand in order of pushes made, so the first
solved state met is push-optimal. A state is the boxes' squares plus the
lowest square of the player's reachable region. The search prunes pushes
onto dead squares (no box there can reach a goal) and pushes that freeze a
box in a 2 x 2 block of walls and boxes off its goal. The budget is a
fixed number of states, never the clock, so two runs write the same bytes.

## Run

`node main.ts` reads `MAKEFUN_INPUT_DIR` (default `/input`) and writes one
`solution.txt` per instance under `MAKEFUN_OUTPUT_DIR` (default `/output`).

Node standard library only; no dependencies.
