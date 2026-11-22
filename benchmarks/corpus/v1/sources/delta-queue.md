# Delta message delivery
## Guarantees
REQ-DEL-51: Delivery is at-least-once.
Exactly-once processing is not guaranteed.
- Consumers deduplicate by event_id.
- Acknowledgements follow durable writes.
