//! Provider protobuf wire. Required zero-valued fields must be encoded (proto2).
use anyhow::{Result, bail, ensure};
use prost::Message;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
#[derive(Clone, PartialEq, Message)]
pub struct Header {
    #[prost(string, required, tag = "1")]
    pub key: String,
    #[prost(string, required, tag = "2")]
    pub value: String,
}
#[derive(Clone, PartialEq, Message)]
pub struct Frame {
    #[prost(uint64, required, tag = "1")]
    pub sequence: u64,
    #[prost(uint64, required, tag = "2")]
    pub log_id: u64,
    #[prost(int32, required, tag = "3")]
    pub service: i32,
    #[prost(int32, required, tag = "4")]
    pub method: i32,
    #[prost(message, repeated, tag = "5")]
    pub headers: Vec<Header>,
    #[prost(string, optional, tag = "6")]
    pub payload_encoding: Option<String>,
    #[prost(string, optional, tag = "7")]
    pub payload_type: Option<String>,
    #[prost(bytes = "vec", optional, tag = "8")]
    pub payload: Option<Vec<u8>>,
    #[prost(string, optional, tag = "9")]
    pub log_id_new: Option<String>,
}
impl Frame {
    pub fn header(&self, key: &str) -> Result<&str> {
        self.optional_header(key)?
            .ok_or_else(|| anyhow::anyhow!("missing Lark frame header"))
    }
    fn optional_header(&self, key: &str) -> Result<Option<&str>> {
        let mut values = self.headers.iter().filter(|h| h.key == key);
        let value = values.next();
        ensure!(values.next().is_none(), "duplicate Lark frame header");
        Ok(value.map(|header| header.value.as_str()))
    }
    pub fn ping(service: i32) -> Self {
        Self {
            service,
            headers: vec![Header {
                key: "type".into(),
                value: "ping".into(),
            }],
            ..Default::default()
        }
    }
    pub fn acknowledgement(mut self, code: u16, elapsed: Duration) -> Self {
        self.headers.retain(|h| h.key != "biz_rt");
        self.headers.push(Header {
            key: "biz_rt".into(),
            value: elapsed.as_millis().to_string(),
        });
        self.payload = Some(format!("{{\"code\":{code}}}").into_bytes());
        self
    }
}
const MAX_BYTES: usize = 1024 * 1024;
struct Partial {
    created: Instant,
    parts: Vec<Option<Vec<u8>>>,
    bytes: usize,
    trace: Option<String>,
    service: i32,
}
#[derive(Default)]
pub struct Fragments {
    messages: HashMap<String, Partial>,
}
impl Fragments {
    pub fn push(&mut self, frame: &Frame, now: Instant) -> Result<Option<Vec<u8>>> {
        self.messages
            .retain(|_, p| now.duration_since(p.created) < Duration::from_secs(10));
        ensure!(frame.headers.len() <= 32, "too many Lark frame headers");
        // The provider SDK treats these as metadata and parses the reassembled
        // payload as JSON. Do not invent an encoding requirement absent from the wire.
        ensure!(
            frame
                .payload_encoding
                .as_ref()
                .is_none_or(|v| v.len() <= 128)
                && frame.payload_type.as_ref().is_none_or(|v| v.len() <= 128),
            "oversized Lark payload metadata"
        );
        let id = frame.header("message_id")?;
        ensure!(
            !id.is_empty() && id.len() <= 256,
            "invalid Lark frame identity"
        );
        let sum: usize = frame.header("sum")?.parse()?;
        let seq: usize = frame.header("seq")?.parse()?;
        ensure!(
            (1..=64).contains(&sum) && seq < sum,
            "invalid Lark fragment coordinates"
        );
        let trace = frame.optional_header("trace_id")?;
        ensure!(
            trace.is_none_or(|v| v.len() <= 256),
            "invalid Lark trace ID"
        );
        let payload = frame
            .payload
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("missing Lark fragment"))?;
        ensure!(payload.len() <= MAX_BYTES, "Lark fragment too large");
        if !self.messages.contains_key(id) {
            ensure!(
                self.messages.len() < 8,
                "Lark fragment assembly capacity exceeded"
            );
            self.messages.insert(
                id.into(),
                Partial {
                    created: now,
                    parts: vec![None; sum],
                    bytes: 0,
                    trace: trace.map(str::to_owned),
                    service: frame.service,
                },
            );
        }
        let entry = self.messages.get_mut(id).unwrap();
        ensure!(
            entry.parts.len() == sum
                && entry.trace.as_deref() == trace
                && entry.service == frame.service,
            "inconsistent Lark fragments"
        );
        if let Some(previous) = &entry.parts[seq] {
            ensure!(previous == payload, "conflicting Lark fragment");
            return Ok(None);
        }
        ensure!(
            entry.bytes + payload.len() <= MAX_BYTES,
            "Lark event too large"
        );
        entry.bytes += payload.len();
        entry.parts[seq] = Some(payload.to_vec());
        if entry.parts.iter().any(Option::is_none) {
            return Ok(None);
        }
        let complete = self.messages.remove(id).unwrap();
        let mut bytes = Vec::with_capacity(complete.bytes);
        for part in complete.parts {
            bytes.extend(part.unwrap());
        }
        Ok(Some(bytes))
    }
    pub fn decode(bytes: &[u8]) -> Result<Frame> {
        ensure!(bytes.len() <= MAX_BYTES, "Lark frame too large");
        let frame = Frame::decode(bytes)?;
        if frame.method != 0 && frame.method != 1 {
            bail!("invalid Lark frame method");
        }
        Ok(frame)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn event(seq: usize) -> Frame {
        Frame {
            method: 1,
            service: 17,
            headers: vec![
                ("type", "event"),
                ("message_id", "m1"),
                ("sum", "2"),
                ("trace_id", "t1"),
            ]
            .into_iter()
            .map(|(k, v)| Header {
                key: k.into(),
                value: v.into(),
            })
            .chain(std::iter::once(Header {
                key: "seq".into(),
                value: seq.to_string(),
            }))
            .collect(),
            payload: Some(if seq == 0 {
                b"{\"a\":".to_vec()
            } else {
                b"1}".to_vec()
            }),
            ..Default::default()
        }
    }
    #[test]
    fn ping_matches_installed_sdk_golden() {
        assert_eq!(
            hex::encode(Frame::ping(17).encode_to_vec()),
            "08001000181120002a0c0a0474797065120470696e67"
        );
    }
    #[test]
    fn bounded_out_of_order_fragments_and_conflicts() {
        let mut cache = Fragments::default();
        let now = Instant::now();
        assert!(cache.push(&event(1), now).unwrap().is_none());
        assert!(cache.push(&event(1), now).unwrap().is_none());
        assert_eq!(
            cache.push(&event(0), now).unwrap(),
            Some(b"{\"a\":1}".to_vec())
        );
        let mut conflict = event(1);
        cache.push(&conflict, now).unwrap();
        conflict.payload = Some(b"different".to_vec());
        assert!(cache.push(&conflict, now).is_err());
        let mut huge = event(0);
        huge.headers
            .iter_mut()
            .find(|h| h.key == "sum")
            .unwrap()
            .value = "100000000".into();
        assert!(cache.push(&huge, now).is_err());
    }
    #[test]
    fn optional_trace_and_native_payload_metadata_do_not_block_json() {
        let mut cache = Fragments::default();
        let now = Instant::now();
        let frames = [event(1), event(0)].map(|mut frame| {
            frame.headers.retain(|h| h.key != "trace_id");
            frame.payload_encoding = Some("json".into());
            frame.payload_type = Some("event".into());
            frame
        });
        assert!(cache.push(&frames[0], now).unwrap().is_none());
        assert_eq!(
            cache.push(&frames[1], now).unwrap(),
            Some(b"{\"a\":1}".to_vec())
        );
    }
    #[test]
    fn fragments_expire_and_acknowledgement_keeps_routing() {
        let mut cache = Fragments::default();
        let now = Instant::now();
        cache.push(&event(0), now).unwrap();
        assert!(
            cache
                .push(&event(1), now + Duration::from_secs(11))
                .unwrap()
                .is_none()
        );
        let ack = event(1).acknowledgement(500, Duration::from_millis(12));
        assert_eq!(ack.header("biz_rt").unwrap(), "12");
        assert_eq!(ack.service, 17);
        assert_eq!(ack.payload.unwrap(), b"{\"code\":500}");
    }
}
