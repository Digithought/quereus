description: Build a graphql plugin to make it easy to query based on FKs in the schema
----

If you can find a graphql parser that is lightweight (especially in terms of dependencies), we don't need to reinvent that wheel.

I built a C# graphQL -> SQL implementation here: C:\projects\pollen\shared\functions\GraphQL 
Could use this as a reference, but in our case it would make sense to go directly into Quereus AST objects rather than writing SQL.  The Database object should probably have the ability to take AST objects alternatively to SQL strings anyways.
