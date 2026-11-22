# Delta retry policy
REQ-DEL-52: Retry at intervals of 2, 4 and 8 seconds.
After three unsuccessful attempts, route to the DLQ.
DLQ означает очередь необработанных сообщений.
