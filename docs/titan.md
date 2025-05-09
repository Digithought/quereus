# Project Titan 

Mission: Migrate SQLite's compiler and runtime from fragile messes to a robust, transparent, and extensible system

## Phases

* Phase I: Robustify existing architecture
  * Compartmentalize and encapsulate compiler state
  * Add debug log-points to runtime
* Phase II: Introduce planner - reasons in logical planning nodes - IR between AST and runtime
  * Initial logical nodes built from AST - planner can move around
  * Allow reasoning in Relational Algebra; e.g HAVING becomes mere restriction
  * Serialization of plans allows for visualization and debugging
  * Compiler generates runtime code from logical plan
* Phase III: Node-based runtime
  * Runtime is composed of execution nodes, rather than instructions
  * Composes more like a functional program
  * In debugging mode, intermediate nodes are placed between runtime nodes to capture state and/or log
  * Cursor and scalar, async and sync nodes; compiler will transition between them


