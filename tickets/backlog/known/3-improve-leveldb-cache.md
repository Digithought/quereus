description: LevelDB uses LRU cache, which is not a good fit for database system access
----

We should look into replacing the LRU policy with a 2Qs cache policy, or something similar, which efficiently incorporates a measure of frequency and avoids dumping hot pages by a scan.  Be sure to include the notion of corellated access interval, so that multiple page accesess within a short period of time, which often happens as part of a single operation, are treated as a single access.

Maybe we also allow configuration of cache size?
