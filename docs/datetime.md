# Date and Time Handling in Quereus

## SQL Date/Time Functions

The built-in SQL functions (`date`, `time`, `datetime`, `julianday`, `strftime`) analogues to SQLite's  functions.

## Internal Implementation

Quereus internally utilizes the [Temporal API](https://tc39.es/proposal-temporal/docs/index.html) (via the [`temporal-polyfill`](https://github.com/fullcalendar/temporal-polyfill)) for all internal date and time operations and for implementing SQL date/time functions. Internal processing relies on `Temporal` objects like `Temporal.Instant`, `Temporal.ZonedDateTime`, `Temporal.PlainDate`, `Temporal.PlainTime`, and `Temporal.PlainDateTime`.  This provides a modern, robust, and unambiguous way to handle dates and times, avoiding the pitfalls of the legacy JavaScript `Date` object.

## Internal Representation

Quereus functions return dates/times formatted as ISO strings (e.g., `YYYY-MM-DD`) or numbers (e.g., Julian day, Unix epoch seconds).

### Input Parsing

The functions attempt to parse the initial time string argument (`timestring`) leniently, similar to SQLite, accepting various formats:

*   **ISO 8601 Formats:**
    *   `YYYY-MM-DD`
    *   `YYYY-MM-DDTHH:MM`
    *   `YYYY-MM-DD HH:MM` (Space separator is accepted)
    *   `YYYY-MM-DDTHH:MM:SS`
    *   `YYYY-MM-DD HH:MM:SS`
    *   `YYYY-MM-DDTHH:MM:SS.sss` (Fractional seconds)
    *   `YYYY-MM-DD HH:MM:SS.sss`
    *   Formats with explicit UTC ('Z') or timezone offsets (`±HH:MM`)
*   **Time Only:**
    *   `HH:MM`
    *   `HH:MM:SS`
    *   `HH:MM:SS.sss`
    (If only time is provided, the date defaults to `2000-01-01` for internal calculations.)
*   **Other Formats:**
    *   `YYYYMMDD`
*   **Special Strings:**
    *   `'now'`: Represents the current date and time in the system's local timezone.
*   **Numeric Formats:**
    *   **Julian Day Number:** Numbers generally between 1,000,000 and 4,000,000 are interpreted as Julian days.
    *   **Unix Epoch:** Other numbers are typically interpreted as seconds since the Unix epoch (1970-01-01 00:00:00 UTC). If the `unixepoch` modifier is used, the number *must* be interpreted as Unix epoch seconds. Ambiguity between large millisecond timestamps and seconds is resolved by prioritizing seconds if the value falls within a reasonable range (approx. 1900-3000 AD).

If parsing fails for any reason, the function generally returns `NULL`.

### Modifiers

The functions support various modifiers (applied sequentially) to adjust the parsed date/time value:

*   **Relative Time:**
    *   `+/- NNN days`
    *   `+/- NNN hours`
    *   `+/- NNN minutes`
    *   `+/- NNN seconds` (Fractional seconds supported)
    *   `+/- NNN months`
    *   `+/- NNN years`
*   **Start/End of Unit:**
    *   `start of day`
    *   `start of month`
    *   `start of year`
*   **Weekday Adjustment:**
    *   `weekday N`: Moves the date *backward* to the last occurrence of weekday N (where N=0 for Sunday, 1 for Monday, ..., 6 for Saturday). If the date is already weekday N, it remains unchanged.
*   **Timezone Control:**
    *   `localtime`: Interprets the `timestring` and performs calculations relative to the system's local timezone. Subsequent formatting (e.g., via `strftime`) will also use the local time.
    *   `utc`: Interprets the `timestring` and performs calculations relative to UTC. Subsequent formatting will use UTC. (This is the default if neither `localtime` nor `utc` is specified).
*   **Special Modifiers:**
    *   `unixepoch`: When present, forces the initial numeric `timestring` value to be interpreted as seconds since the Unix epoch.

Unrecognized modifiers are typically ignored. If applying a modifier causes an error (e.g., invalid numeric value), the function returns `NULL`.

### Return Values

*   `date()`: Returns `YYYY-MM-DD` string.
*   `time()`: Returns `HH:MM:SS` string.
*   `datetime()`: Returns `YYYY-MM-DD HH:MM:SS` string.
*   `julianday()`: Returns a floating-point number representing the Julian day.
*   `strftime(format, ...)`: Returns a string formatted according to the `format` string specifiers (see below).

### `strftime` Formats

The `strftime` function supports the following common format specifiers:

*   `%Y`: Year (e.g., 2023)
*   `%m`: Month (01-12)
*   `%d`: Day of month (01-31)
*   `%H`: Hour (00-23)
*   `%M`: Minute (00-59)
*   `%S`: Second (00-59)
*   `%f`: Fractional seconds (e.g., `.123`) - Currently outputs milliseconds.
*   `%j`: Day of year (001-366)
*   `%w`: Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)
*   `%W`: Week of year (ISO 8601 week number, 01-53)
*   `%s`: Seconds since Unix epoch (integer)
*   `%%`: Literal `%`

Unsupported specifiers are outputted literally.

## Timezones

Calculations involving modifiers are performed using the timezone determined by the `localtime` or `utc` modifiers (defaulting to UTC). `Temporal.ZonedDateTime` handles DST transitions correctly during arithmetic. Formatting via `strftime` respects the determined timezone. `'now'` always uses the system's local time zone. 
