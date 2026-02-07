The tasks folder contains fix, plan, implement, review, test, and complete subfolders.  Each task is an md file under these folders, having a descriptive filename prefixed with a 1-5 priority (5 being highest priority).  

Stages:
- Fix - for bugs in existing functionality.  These should be researched and elaborated, with one or more hypothesis made as to the cause and correction.  References should be made to key files and documentation.  TODO tasks should be added to the bottom of the md file.  The output is a corresponding plan md file in the implement folder, and delete the file from /fix.
- Plan - for features and enhancements.  Research and elaborate on these.  If there are questions about different options, list the options in the output file.  References should be made to key files and documentation.  TODO tasks should be added to the bottom of the md file.  The output is a corresponding plan md file in the implement folder, and delete the file from /plan.
- Implement - These tasks are ready for implementation (fix, build, review, write test, ...whatever the task specifies).  If more than one agent would be useful, without stepping on toes, spawn sub-agents.  Once complete, output a distilled summary of the task, with emphasis on testing, validation and usage into the /review folder and delete the task from /implement.
- Review - First, ensure there are tests for the task.  Try to look only at the interface points for the task initially to avoid biasing the tests towards the implementation.  Then inspect the code against all aspect-oriented criteria (SPP, DRY, modular, etc.).  Once the tests pass and code is solid, output an md file for the task in /complete, and delete the /review one.

Don't combine tasks unless they are tightly related.

For new tasks: put a new file into /fix or /plan but focus on the description of the issue or feature, expected behavior, use case, etc.  Don't do planning, add tasks, or get ahead, unless you happen to know something already that would be useful.

For the file:
----
description: <brief description>
dependencies: <needed other tasks, contribution points, external libraries>
priority: <1-5>
----
<timeless architecture description focused on prose, diagrams, and interfaces/types/schema>

<if adding to implement or review: TODO list of detailed tasks - avoid lots of numbering of tasks, besides phases>
