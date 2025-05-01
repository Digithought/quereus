// These must be < 256 unless you update handlers.ts
export enum Opcode {
	// --- Core Control Flow (0-9) ---
	Halt = 0,         // Stop execution
	Init = 1,         // Program initialization
	Goto = 2,         // Unconditional jump
	Noop = 3,         // No operation
	Once = 4,         // Run P2..P3 block only once

	// --- Data Loading / Constants (10-19) ---
	Null = 10,        // Push NULL onto stack
	Integer = 11,       // Push integer P1 onto stack
	Int64 = 12,       // Push Int64 P4 onto stack
	String8 = 13,     // Push string P4 (len P1) onto stack
	Real = 14,        // Push real P4 onto stack
	Blob = 15,        // Push Blob P4 (len P1) onto stack
	ZeroBlob = 16,    // Push Blob of size P1 filled with zeros

	// --- Register Manipulation (20-29) ---
	SCopy = 20,       // Copy register P1 to P2
	Move = 21,        // Move P2 registers starting at P1 to P3
	Clear = 22,       // Clear P2 registers starting at P1
	Push = 23,        // Push register P1 onto stack frame (for subroutines)
	StackPop = 24,    // Pop from stack frame into register P1 (for subroutines)

	// --- Conditional Jumps / Comparisons (30-49) ---
	IfTrue = 30,      // Jump to P2 if register P1 is true
	IfFalse = 31,     // Jump to P2 if register P1 is false
	IfZero = 32,      // Jump to P2 if register P1 is zero or NULL
	IfNull = 33,      // Jump to P2 if register P1 is NULL
	IfNotNull = 34,   // Jump to P2 if register P1 is not NULL
	IsNull = 35,      // Write 1 to P2 if P1 is NULL, else 0
	NotNull = 36,     // Write 1 to P2 if P1 is not NULL, else 0
	Eq = 37,          // Jump to P2 if P1 == P3 (uses collation P4)
	Ne = 38,          // Jump to P2 if P1 != P3 (uses collation P4)
	Lt = 39,          // Jump to P2 if P1 < P3 (uses collation P4)
	Le = 40,          // Jump to P2 if P1 <= P3 (uses collation P4)
	Gt = 41,          // Jump to P2 if P1 > P3 (uses collation P4)
	Ge = 42,          // Jump to P2 if P1 >= P3 (uses collation P4)
	IfPos = 43,       // Jump to P2 if register P1 > 0
	IfNeg = 44,       // Jump to P2 if register P1 < 0

	// --- Arithmetic / Logic (50-59) ---
	Add = 50,         // P3 = P1 + P2
	Subtract = 51,    // P3 = P1 - P2
	Multiply = 52,    // P3 = P1 * P2
	Divide = 53,      // P3 = P1 / P2
	Remainder = 54,   // P3 = P1 % P2
	Concat = 55,      // P3 = P1 || P2

	// --- Bitwise / Unary (60-69) ---
	Negative = 60,    // P2 = -P1
	BitAnd = 61,      // P3 = P1 & P2
	BitOr = 62,       // P3 = P1 | P2
	ShiftLeft = 63,   // P3 = P1 << P2
	ShiftRight = 64,  // P3 = P1 >> P2
	BitNot = 65,      // P2 = ~P1
	Not = 66,         // P2 = !P1

	// --- Type Affinity / Conversion (70-79) ---
	Affinity = 70,    // Apply affinity P4 to P2 registers starting from P1

	// --- Cursor / Table Operations (80-99) ---
	OpenRead = 80,    // Open cursor P1 for reading table P2 with root page P3
	OpenWrite = 81,   // Open cursor P1 for writing table P2 with root page P3
	OpenEphemeral = 82, // Open cursor P1 for ephemeral table P2 (P4 is Record)
	OpenPseudo = 83,  // Open cursor P1 for pseudo table P3 (pointed to by P2)
	Close = 84,       // Close cursor P1
	Rewind = 85,      // Rewind cursor P1 to the beginning, jump to P2 on empty
	Next = 86,        // Advance cursor P1 to the next row, jump to P2 on end
	SeekRowid = 87,   // Seek cursor P1 to rowid P3, jump to P2 on not found
	IdxInsert = 88,   // Insert record from P2 into index cursor P1 (P3=dest reg)
	MakeRecord = 89,  // Create record from P2 registers starting at P1 into P3 (P4=affinity)
	ResultRow = 90,   // Output P2 registers starting at P1 as a result row

	// --- Virtual Table Operations (100-119) ---
	VFilter = 100,    // Filter virtual table P1 (cursor P2), jump to P3 on end, using arguments in P4
	VNext = 101,      // Advance virtual table cursor P1, jump to P2 on end
	VColumn = 102,    // Get column P2 from virtual table P1 into register P3
	VUpdate = 103,    // Update virtual table P1 (P2=argc, P3=dest reg, P4=values start reg)
	VRowid = 104,     // Get rowid from virtual table P1 into register P2
	VBegin = 105,     // Begin transaction on virtual table P1
	VCommit = 106,    // Commit transaction on virtual table P1
	VRollback = 107,  // Rollback transaction on virtual table P1
	VSync = 108,      // Sync virtual table P1
	VSavepoint = 109, // Create savepoint P2 on virtual table P1
	VRelease = 110,   // Release savepoint P2 on virtual table P1
	VRollbackTo = 111,// Rollback to savepoint P2 on virtual table P1
	VCreateIndex = 112, // Create index P3 on virtual table P1 using info in P4
	VDropIndex = 113, // Drop index P3 on virtual table P1

	// --- Subroutines / Functions (120-129) ---
	Function = 120,   // Call function P5 with P2 args from P1 into P3
	Subroutine = 121, // Call subroutine starting at P2, return to P1+1 (P4=frame reg)
	Return = 122,     // Return from subroutine (P1=frame reg)

	// --- Aggregation (130-149) ---
	AggStep = 130,    // Execute one step of an aggregate function (P4=context)
	AggFinal = 131,   // Finalize an aggregate function (P4=context)
	AggIterate = 132, // Iterate through aggregation buckets (P1=cursor, P2=end addr)
	AggNext = 133,    // Move to next aggregation bucket (P1=cursor, P2=next addr)
	AggKey = 134,     // Get aggregation key (P1=cursor, P2=num keys, P3=dest reg)
	AggReset = 135,   // Reset aggregate context (P1=agg obj reg)
	AggContext = 136, // Push agg context info to stack (P1=agg obj reg)
	AggGroupValue = 137, // Get value from group register (P1=agg obj reg, P2=group reg offset, P3=dest reg)
	AggGetContext = 138, // Pop agg context info from stack (P1=agg obj reg)
	AggGetAccumulatorByKey = 139, // Get accumulator for a specific key (P1=agg obj reg, P2=key reg, P3=dest reg)

	// --- Sorting (150-159) ---
	Sort = 150,       // Sort cursor P1, jump to P2 on completion
	WindowSort = 151, // Sort window ephemeral table P1 (P2=sorter reg, P3=num rows reg)

	// --- Schema / DDL (160-179) ---
	VerifyCookie = 160,// Verify schema cookie P1 is P2, jump to P3 on mismatch
	SchemaInvalidate = 161, // Mark schema as invalid
	SchemaLoad = 162, // Load schema
	CreateIndex = 163,// Create index P2 named P1 on table P3 (P4=flags)
	CreateTable = 164,// Create table P1 (P2=flags)
	CreateView = 165, // Create view P1 (P2=flags)
	DropTable = 166,  // Drop table P1 (P2=db index)
	DropIndex = 167,  // Drop index P1 (P2=db index)
	DropView = 168,   // Drop view P1 (P2=db index)
	AlterTable = 169, // Alter table P1 (P2=db index, P3=flags)
	SchemaChange = 170,// Notify schema change (P1=db index)

	// --- Transaction Control (180-189) ---
	Savepoint = 180,  // Savepoint operation P1 named P4 (0=BEGIN, 1=RELEASE, 2=ROLLBACK)
	Checkpoint = 181, // Checkpoint database P1 (P2=mode, P3=output reg)

	// --- Frame Management (190-199) ---
	FrameEnter = 190, // Enter stack frame P1 (P2=size)
	FrameLeave = 191, // Leave stack frame P1
	SeekRelative = 192, // Seek cursor P1 relative to current position P2, jump P3

	// --- Table Valued Functions (TVF) (200-209) ---
	OpenTvf = 200,    // Open TVF cursor P1 (P2=argc, P3=argv reg, P4=Module ptr)

	// --- Miscellaneous (210-219) ---
	CollSeq = 210,    // Use collation sequence P1 for register P2
	ConstraintViolation = 211, // Raise a constraint violation

} // End Opcode Enum

