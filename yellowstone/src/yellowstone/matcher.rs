use crate::control_plane::WorkspaceTransferRequestMatch;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

#[derive(Default)]
pub struct MatcherState {
    request_states: HashMap<String, RequestFillState>,
}

impl MatcherState {
    pub fn set_request_state(&mut self, transfer_request_id: String, state: RequestFillState) {
        self.request_states.insert(transfer_request_id, state);
    }

    pub fn request_state(&self, transfer_request_id: &str) -> RequestFillState {
        self.request_states
            .get(transfer_request_id)
            .cloned()
            .unwrap_or_default()
    }
}

#[derive(Clone, Debug, Default)]
pub struct RequestFillState {
    pub allocated_amount_raw: i128,
    pub remaining_amount_raw: i128,
    pub fill_count: u32,
    pub book_status: String,
    pub last_signature: Option<String>,
}

#[derive(Clone)]
pub struct BookRequest<'a> {
    pub request: &'a WorkspaceTransferRequestMatch,
    pub fill_state: RequestFillState,
}

#[derive(Clone, Debug)]
pub struct BookAllocation {
    pub transfer_request_id: String,
    pub allocated_now_raw: i128,
    pub allocated_total_raw: i128,
    pub remaining_request_raw: i128,
    pub fill_count: u32,
    pub match_status: &'static str,
    pub time_delta_seconds: i64,
}

pub struct AllocationResult {
    pub allocations: Vec<BookAllocation>,
    pub remaining_observation_raw: i128,
    pub eligible_request_count: usize,
}

pub fn allocate_observation(
    observed_amount_raw: i128,
    observed_at: DateTime<Utc>,
    requests: &[BookRequest<'_>],
) -> AllocationResult {
    let mut eligible_requests: Vec<&BookRequest<'_>> = requests
        .iter()
        .filter(|entry| entry.fill_state.remaining_amount_raw > 0)
        .collect();

    eligible_requests.sort_by(|left, right| {
        left.request
            .requested_at
            .cmp(&right.request.requested_at)
            .then_with(|| {
                left.request
                    .transfer_request_id
                    .cmp(&right.request.transfer_request_id)
            })
    });

    let eligible_request_count = eligible_requests.len();
    let mut remaining_observation_raw = observed_amount_raw;
    let mut allocations = Vec::new();

    for entry in eligible_requests {
        if remaining_observation_raw <= 0 {
            break;
        }

        let request_remaining = entry.fill_state.remaining_amount_raw;
        if request_remaining <= 0 {
            continue;
        }

        let allocated_now_raw = remaining_observation_raw.min(request_remaining);
        if allocated_now_raw <= 0 {
            continue;
        }

        let allocated_total_raw = entry.fill_state.allocated_amount_raw + allocated_now_raw;
        let remaining_request_raw = request_remaining - allocated_now_raw;
        let fill_count = entry.fill_state.fill_count + 1;
        let match_status = if remaining_request_raw == 0 {
            if fill_count == 1 {
                "matched_exact"
            } else {
                "matched_split"
            }
        } else {
            "matched_partial"
        };

        allocations.push(BookAllocation {
            transfer_request_id: entry.request.transfer_request_id.clone(),
            allocated_now_raw,
            allocated_total_raw,
            remaining_request_raw,
            fill_count,
            match_status,
            time_delta_seconds: observed_at
                .signed_duration_since(entry.request.requested_at)
                .num_seconds(),
        });

        remaining_observation_raw -= allocated_now_raw;
    }

    AllocationResult {
        allocations,
        remaining_observation_raw,
        eligible_request_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn request(id: &str, requested_at: DateTime<Utc>, amount_raw: i128) -> WorkspaceTransferRequestMatch {
        WorkspaceTransferRequestMatch {
            transfer_request_id: id.to_string(),
            workspace_id: "workspace-1".to_string(),
            destination_match_address: "Dest111".to_string(),
            amount_raw,
            requested_at,
            request_type: "wallet_transfer".to_string(),
        }
    }

    #[test]
    fn allocator_fills_exact_in_fifo_order() {
        let requested_at = Utc::now();
        let request_1 = request("request-1", requested_at, 10_000);
        let requests = vec![BookRequest {
            request: &request_1,
            fill_state: RequestFillState {
                allocated_amount_raw: 0,
                remaining_amount_raw: 10_000,
                fill_count: 0,
                book_status: "open".to_string(),
                last_signature: None,
            },
        }];

        let result = allocate_observation(10_000, requested_at + Duration::seconds(5), &requests);
        assert_eq!(result.allocations.len(), 1);
        assert_eq!(result.allocations[0].match_status, "matched_exact");
        assert_eq!(result.allocations[0].remaining_request_raw, 0);
        assert_eq!(result.remaining_observation_raw, 0);
    }

    #[test]
    fn allocator_supports_partial_fill() {
        let requested_at = Utc::now();
        let request_1 = request("request-1", requested_at, 10_000);
        let requests = vec![BookRequest {
            request: &request_1,
            fill_state: RequestFillState {
                allocated_amount_raw: 0,
                remaining_amount_raw: 10_000,
                fill_count: 0,
                book_status: "open".to_string(),
                last_signature: None,
            },
        }];

        let result = allocate_observation(9_193, requested_at + Duration::seconds(5), &requests);
        assert_eq!(result.allocations.len(), 1);
        assert_eq!(result.allocations[0].match_status, "matched_partial");
        assert_eq!(result.allocations[0].remaining_request_raw, 807);
        assert_eq!(result.remaining_observation_raw, 0);
    }

    #[test]
    fn allocator_supports_split_fill_on_second_observation() {
        let requested_at = Utc::now();
        let request_1 = request("request-1", requested_at, 10_000);
        let requests = vec![BookRequest {
            request: &request_1,
            fill_state: RequestFillState {
                allocated_amount_raw: 9_193,
                remaining_amount_raw: 807,
                fill_count: 1,
                book_status: "matched_partial".to_string(),
                last_signature: Some("sig-1".to_string()),
            },
        }];

        let result = allocate_observation(807, requested_at + Duration::seconds(10), &requests);
        assert_eq!(result.allocations.len(), 1);
        assert_eq!(result.allocations[0].match_status, "matched_split");
        assert_eq!(result.allocations[0].allocated_total_raw, 10_000);
        assert_eq!(result.allocations[0].remaining_request_raw, 0);
        assert_eq!(result.remaining_observation_raw, 0);
    }

    #[test]
    fn allocator_respects_fifo_across_multiple_requests() {
        let requested_at = Utc::now();
        let request_1 = request("request-1", requested_at, 8_000);
        let request_2 = request("request-2", requested_at + Duration::seconds(1), 5_000);

        let requests = vec![
            BookRequest {
                request: &request_2,
                fill_state: RequestFillState {
                    allocated_amount_raw: 0,
                    remaining_amount_raw: 5_000,
                    fill_count: 0,
                    book_status: "open".to_string(),
                    last_signature: None,
                },
            },
            BookRequest {
                request: &request_1,
                fill_state: RequestFillState {
                    allocated_amount_raw: 0,
                    remaining_amount_raw: 8_000,
                    fill_count: 0,
                    book_status: "open".to_string(),
                    last_signature: None,
                },
            },
        ];

        let result = allocate_observation(10_000, requested_at + Duration::seconds(5), &requests);
        assert_eq!(result.allocations.len(), 2);
        assert_eq!(result.allocations[0].transfer_request_id, "request-1");
        assert_eq!(result.allocations[0].allocated_now_raw, 8_000);
        assert_eq!(result.allocations[1].transfer_request_id, "request-2");
        assert_eq!(result.allocations[1].allocated_now_raw, 2_000);
        assert_eq!(result.remaining_observation_raw, 0);
    }

    #[test]
    fn allocator_leaves_residual_when_observation_overfills_book() {
        let requested_at = Utc::now();
        let request_1 = request("request-1", requested_at, 10_000);
        let requests = vec![BookRequest {
            request: &request_1,
            fill_state: RequestFillState {
                allocated_amount_raw: 0,
                remaining_amount_raw: 10_000,
                fill_count: 0,
                book_status: "open".to_string(),
                last_signature: None,
            },
        }];

        let result = allocate_observation(12_000, requested_at + Duration::seconds(5), &requests);
        assert_eq!(result.allocations.len(), 1);
        assert_eq!(result.allocations[0].allocated_now_raw, 10_000);
        assert_eq!(result.remaining_observation_raw, 2_000);
    }
}
