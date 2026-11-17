-- Version lineage is advisory and scoped to the same payment request.
ALTER TABLE gateway_case_packets ADD CONSTRAINT case_packet_request_identity UNIQUE(request_id,id);
ALTER TABLE gateway_case_packets ADD COLUMN parent_id bigint;
ALTER TABLE gateway_case_packets ADD CONSTRAINT case_packet_parent_scope
  FOREIGN KEY(request_id,parent_id) REFERENCES gateway_case_packets(request_id,id);
CREATE UNIQUE INDEX case_packet_single_successor ON gateway_case_packets(parent_id) WHERE parent_id IS NOT NULL;
