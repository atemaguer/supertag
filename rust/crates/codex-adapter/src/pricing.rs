//! Attempt cost estimates using the model rates pinned by SuperTag's Codex integration.
use supertag_protocol::v2::NativeTokenUsage;

// Whole USD per billion tokens. These are the legacy Standard short-context rates;
// Attempt totals do not expose per-request long-context or cache-write surcharges.
fn rates(model: &str) -> Option<[u128; 3]> {
    match model {
        "gpt-5" | "gpt-5.1" => Some([1_250, 125, 10_000]),
        "gpt-5.2" | "gpt-5.3-codex" => Some([1_750, 175, 14_000]),
        "gpt-5.4" => Some([2_500, 250, 15_000]),
        "gpt-6-astra" => Some([10_000, 1_000, 50_000]),
        "gpt-6-luna" => Some([100, 10, 500]),
        "gpt-6-sol" => Some([2_000, 200, 10_000]),
        "gpt-6.1-sol" => Some([2_000, 100, 10_000]),
        _ => None,
    }
}

pub(crate) fn estimated_cost_minor(model: Option<&str>, usage: &NativeTokenUsage) -> Option<u64> {
    const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let [input, cached, output] = rates(model.unwrap_or("gpt-5.4"))?;
    let uncached = usage.input_tokens.checked_sub(usage.cached_input_tokens)?;
    let cost = (u128::from(uncached) * input
        + u128::from(usage.cached_input_tokens) * cached
        + u128::from(usage.output_tokens) * output)
        .div_ceil(10_000_000);
    u64::try_from(cost)
        .ok()
        .filter(|cost| *cost <= SAFE_INTEGER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_uncached_cached_and_output_tokens_separately() {
        let usage = NativeTokenUsage {
            input_tokens: 1_000_000,
            cached_input_tokens: 100_000,
            output_tokens: 50_000,
            ..Default::default()
        };
        assert_eq!(estimated_cost_minor(Some("gpt-5.4"), &usage), Some(303));
        assert_eq!(estimated_cost_minor(None, &usage), Some(303));
        assert_eq!(estimated_cost_minor(Some("unknown-model"), &usage), None);
    }

    #[test]
    fn rounds_up_to_minor_units_and_refuses_invalid_counter_relationship() {
        let mut usage = NativeTokenUsage {
            input_tokens: 1,
            ..Default::default()
        };
        assert_eq!(estimated_cost_minor(Some("gpt-6-luna"), &usage), Some(1));
        usage.cached_input_tokens = 2;
        assert_eq!(estimated_cost_minor(Some("gpt-6-luna"), &usage), None);
    }
}
