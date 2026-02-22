----
description: Generalize bloom and any hashing needs to work across compound keys and collations
----

The bloom join's implementation seems hard-coded.  Let's explore how to generalize it, and review anywhere in the system where we may be relying on hash behavior.
