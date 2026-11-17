//! How long this Control Plane process takes to admit collaboration surface events. A Gateway
//! acknowledges an event only after admission commits, within its own deadline, so slow admission
//! means redeliveries and, past the deadline, a lost acknowledgement. The counts are in memory:
//! there is no record to read them from, and timing a write with another write would slow every
//! admission. Each replica reports its own.
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use supertag_protocol::v2::{MetricAdmission, MetricSurfaceAdmission};

/// The Slack Socket Mode acknowledgement deadline, the shortest any Gateway allows.
pub(crate) const ADMISSION_DEADLINE: Duration = Duration::from_secs(2);

#[derive(Default, Clone, Copy)]
struct Counts {
    admitted: i64,
    failed: i64,
    total_ms: i64,
    maximum_ms: i64,
    over_deadline: i64,
}

pub(crate) struct Admissions {
    since_ms: i64,
    surfaces: Mutex<BTreeMap<&'static str, Counts>>,
}

impl Default for Admissions {
    fn default() -> Self {
        Self {
            since_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as i64),
            surfaces: Mutex::default(),
        }
    }
}

impl Admissions {
    pub(crate) fn record(&self, surface: &'static str, elapsed: Duration, admitted: bool) {
        let ms = i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX);
        let mut surfaces = self.surfaces.lock().unwrap_or_else(|e| e.into_inner());
        let counts = surfaces.entry(surface).or_default();
        if admitted {
            counts.admitted += 1;
        } else {
            counts.failed += 1;
        }
        counts.total_ms = counts.total_ms.saturating_add(ms);
        counts.maximum_ms = counts.maximum_ms.max(ms);
        counts.over_deadline += i64::from(elapsed > ADMISSION_DEADLINE);
    }

    /// Times one admission call.
    pub(crate) async fn time<T, E>(
        &self,
        surface: &'static str,
        call: impl Future<Output = Result<T, E>>,
    ) -> Result<T, E> {
        let started = Instant::now();
        let result = call.await;
        self.record(surface, started.elapsed(), result.is_ok());
        result
    }

    pub(crate) fn snapshot(&self) -> MetricAdmission {
        let surfaces = self.surfaces.lock().unwrap_or_else(|e| e.into_inner());
        MetricAdmission {
            since_ms: self.since_ms,
            surfaces: surfaces
                .iter()
                .map(|(surface, counts)| {
                    let calls = counts.admitted + counts.failed;
                    MetricSurfaceAdmission {
                        surface: (*surface).to_owned(),
                        admitted: counts.admitted,
                        failed: counts.failed,
                        average_ms: if calls == 0 {
                            0
                        } else {
                            counts.total_ms / calls
                        },
                        maximum_ms: counts.maximum_ms,
                        over_deadline: counts.over_deadline,
                    }
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn counts_each_surface_and_the_calls_past_the_deadline() {
        let admissions = Admissions::default();
        admissions.record("slack", Duration::from_millis(100), true);
        admissions.record("slack", Duration::from_millis(2_500), true);
        admissions.record("slack", Duration::from_millis(300), false);
        let timed: Result<(), ()> = admissions.time("teams", async { Err(()) }).await;
        assert!(timed.is_err());
        let snapshot = admissions.snapshot();
        assert!(snapshot.since_ms > 0);
        assert_eq!(
            snapshot.surfaces,
            [
                MetricSurfaceAdmission {
                    surface: "slack".into(),
                    admitted: 2,
                    failed: 1,
                    average_ms: 966,
                    maximum_ms: 2_500,
                    over_deadline: 1,
                },
                MetricSurfaceAdmission {
                    surface: "teams".into(),
                    admitted: 0,
                    failed: 1,
                    average_ms: 0,
                    maximum_ms: 0,
                    over_deadline: 0,
                },
            ]
        );
    }
}
