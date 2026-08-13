use std::io::{self, Read, Write};

use thiserror::Error;

pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ReadFrame {
    Eof,
    Message(Vec<u8>),
}

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("truncated Native Messaging frame length")]
    TruncatedLength,
    #[error("truncated Native Messaging frame body")]
    TruncatedBody,
    #[error("Native Messaging frame exceeds the size limit")]
    Oversized,
    #[error("Native Messaging I/O failed")]
    Io(#[from] io::Error),
}

pub fn read_frame(reader: &mut impl Read) -> Result<ReadFrame, FrameError> {
    let mut length_bytes = [0_u8; 4];
    let mut length_read = 0;
    while length_read < length_bytes.len() {
        match reader.read(&mut length_bytes[length_read..]) {
            Ok(0) if length_read == 0 => return Ok(ReadFrame::Eof),
            Ok(0) => return Err(FrameError::TruncatedLength),
            Ok(count) => length_read += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(FrameError::Io(error)),
        }
    }

    let length = u32::from_le_bytes(length_bytes) as usize;
    if length > MAX_MESSAGE_BYTES {
        return Err(FrameError::Oversized);
    }

    let mut body = vec![0_u8; length];
    let mut body_read = 0;
    while body_read < body.len() {
        match reader.read(&mut body[body_read..]) {
            Ok(0) => return Err(FrameError::TruncatedBody),
            Ok(count) => body_read += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(FrameError::Io(error)),
        }
    }
    Ok(ReadFrame::Message(body))
}

pub fn write_frame(writer: &mut impl Write, body: &[u8]) -> Result<(), FrameError> {
    if body.len() > MAX_MESSAGE_BYTES {
        return Err(FrameError::Oversized);
    }
    let length = u32::try_from(body.len()).map_err(|_| FrameError::Oversized)?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(body)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn frame(body: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, body).expect("frame should be writable");
        bytes
    }

    #[test]
    fn reads_a_valid_frame() {
        let mut input = Cursor::new(frame(br#"{"method":"ping"}"#));
        assert_eq!(
            read_frame(&mut input).expect("frame should parse"),
            ReadFrame::Message(br#"{"method":"ping"}"#.to_vec())
        );
    }

    #[test]
    fn rejects_a_truncated_length() {
        let mut input = Cursor::new(vec![1, 0]);
        assert!(matches!(
            read_frame(&mut input),
            Err(FrameError::TruncatedLength)
        ));
    }

    #[test]
    fn rejects_a_truncated_body() {
        let mut input = Cursor::new(vec![5, 0, 0, 0, b'a']);
        assert!(matches!(
            read_frame(&mut input),
            Err(FrameError::TruncatedBody)
        ));
    }

    #[test]
    fn rejects_an_oversized_message_without_allocating_it() {
        let mut input = Cursor::new(((MAX_MESSAGE_BYTES as u32) + 1).to_le_bytes());
        assert!(matches!(read_frame(&mut input), Err(FrameError::Oversized)));
    }

    #[test]
    fn reads_multiple_sequential_messages() {
        let mut bytes = frame(b"one");
        bytes.extend(frame(b"two"));
        let mut input = Cursor::new(bytes);
        assert_eq!(
            read_frame(&mut input).unwrap(),
            ReadFrame::Message(b"one".to_vec())
        );
        assert_eq!(
            read_frame(&mut input).unwrap(),
            ReadFrame::Message(b"two".to_vec())
        );
        assert_eq!(read_frame(&mut input).unwrap(), ReadFrame::Eof);
    }

    #[test]
    fn clean_eof_is_not_an_error() {
        assert_eq!(
            read_frame(&mut Cursor::new(Vec::<u8>::new())).unwrap(),
            ReadFrame::Eof
        );
    }
}
