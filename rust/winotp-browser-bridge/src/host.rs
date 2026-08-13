use std::io::{Read, Write};

use serde_json::{Value, json};

use crate::framing::{FrameError, ReadFrame, read_frame, write_frame};
use crate::ipc::{DesktopTransport, TransportError};
use crate::protocol::{
    ErrorCode, INVALID_REQUEST_ID, NativeRequest, PROTOCOL_VERSION, RequestMethod, error_response,
    parse_request, success_response,
};

pub fn handle_request(request: &NativeRequest, transport: &impl DesktopTransport) -> Value {
    if request.method == RequestMethod::Ping {
        return success_response(
            &request.request_id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "bridgeVersion": env!("CARGO_PKG_VERSION"),
            }),
        );
    }

    match transport.send(request) {
        Ok(response) => response,
        Err(TransportError::AppUnavailable) => error_response(
            &request.request_id,
            ErrorCode::AppNotRunning,
            "WinOTP is not running",
        ),
        Err(TransportError::InvalidDescriptor | TransportError::InvalidResponse) => error_response(
            &request.request_id,
            ErrorCode::NativeHostError,
            "The local WinOTP bridge is unavailable",
        ),
    }
}

fn write_value(writer: &mut impl Write, value: &Value) -> Result<(), FrameError> {
    let body = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    write_frame(writer, &body)
}

pub fn run(
    reader: &mut impl Read,
    writer: &mut impl Write,
    transport: &impl DesktopTransport,
) -> Result<(), FrameError> {
    loop {
        let body = match read_frame(reader) {
            Ok(ReadFrame::Eof) => return Ok(()),
            Ok(ReadFrame::Message(body)) => body,
            Err(
                error @ (FrameError::TruncatedLength
                | FrameError::TruncatedBody
                | FrameError::Oversized),
            ) => {
                write_value(
                    writer,
                    &error_response(
                        INVALID_REQUEST_ID,
                        ErrorCode::InvalidRequest,
                        &error.to_string(),
                    ),
                )?;
                return Ok(());
            }
            Err(error) => return Err(error),
        };

        let response = match parse_request(&body) {
            Ok(request) => handle_request(&request, transport),
            Err(error) => error_response(&error.request_id, error.code, error.message),
        };
        write_value(writer, &response)?;
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::framing::{ReadFrame, read_frame, write_frame};
    use crate::ipc::TransportError;
    use crate::protocol::{RequestMethod, error_response};

    struct FakeTransport(Result<Value, TransportError>);

    impl DesktopTransport for FakeTransport {
        fn send(&self, _request: &NativeRequest) -> Result<Value, TransportError> {
            match &self.0 {
                Ok(value) => Ok(value.clone()),
                Err(TransportError::AppUnavailable) => Err(TransportError::AppUnavailable),
                Err(TransportError::InvalidDescriptor) => Err(TransportError::InvalidDescriptor),
                Err(TransportError::InvalidResponse) => Err(TransportError::InvalidResponse),
            }
        }
    }

    #[test]
    fn ping_is_answered_without_contacting_the_desktop_app() {
        let request = NativeRequest {
            request_id: "request-1".to_owned(),
            method: RequestMethod::Ping,
        };
        let response = handle_request(
            &request,
            &FakeTransport(Err(TransportError::InvalidResponse)),
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["protocolVersion"], 1);
    }

    #[test]
    fn unavailable_app_returns_a_structured_error() {
        let request = NativeRequest {
            request_id: "request-1".to_owned(),
            method: RequestMethod::GetStatus,
        };
        let response = handle_request(
            &request,
            &FakeTransport(Err(TransportError::AppUnavailable)),
        );
        assert_eq!(response["error"]["code"], "APP_NOT_RUNNING");
    }

    #[test]
    fn locked_desktop_response_is_forwarded_without_metadata() {
        let request = NativeRequest {
            request_id: "request-1".to_owned(),
            method: RequestMethod::ListAccounts,
        };
        let locked = error_response(
            &request.request_id,
            ErrorCode::AppLocked,
            "WinOTP is locked",
        );
        let response = handle_request(&request, &FakeTransport(Ok(locked)));
        assert_eq!(response["error"]["code"], "APP_LOCKED");
        assert!(response.get("result").is_none());
    }

    #[test]
    fn run_handles_multiple_frames_and_malformed_json() {
        let mut input = Vec::new();
        write_frame(
            &mut input,
            br#"{"version":1,"requestId":"request-1","method":"ping"}"#,
        )
        .unwrap();
        write_frame(&mut input, br#"{"version":1,"#).unwrap();
        let mut output = Vec::new();
        run(
            &mut Cursor::new(input),
            &mut output,
            &FakeTransport(Err(TransportError::AppUnavailable)),
        )
        .unwrap();
        let mut output = Cursor::new(output);
        let ReadFrame::Message(first) = read_frame(&mut output).unwrap() else {
            panic!("expected first response")
        };
        let ReadFrame::Message(second) = read_frame(&mut output).unwrap() else {
            panic!("expected second response")
        };
        assert_eq!(serde_json::from_slice::<Value>(&first).unwrap()["ok"], true);
        assert_eq!(
            serde_json::from_slice::<Value>(&second).unwrap()["error"]["code"],
            "INVALID_REQUEST"
        );
    }
}
