/*
 * hash/blo
.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

use arraystring::ArrayString;
use sha2::{Digest, Sha512};
use typenum::U128;

pub const BLOB_HASH_LENGTH: usize = 64;

pub type BlobHash = [u8; 64];

pub type BlobHexHash = ArrayString<U128>;

pub fn sha512_hash(data: &[u8]) -> BlobHash {
    let mut hasher = Sha512::new();
    hasher.update(data);
    let result = hasher.finalize();
    slice_to_blob_hash(&result)
}

pub fn slice_to_blob_hash(slice: &[u8]) -> BlobHash {
    let mut hash = [0; 64];
    hash.copy_from_slice(slice);
    hash
}

pub fn blob_hash_to_hex(hash: &[u8]) -> BlobHexHash {
    debug_assert_eq!(
        hash.len(),
        BLOB_HASH_LENGTH,
        "SHA-512 hash buffer of incorrect length",
    );

    let mut hex_bytes = [0; 128];

    hex::encode_to_slice(hash, &mut hex_bytes)
        .expect("Encoding hash to hex slice failed");

    ArrayString::from_utf8(hex_bytes).expect("Encoded hash was not UTF-8")
}

#[test]
fn sha512_hash_matches_known_digest() {
    let hash = sha512_hash(b"wikijump");

    assert_eq!(hash.len(), BLOB_HASH_LENGTH);
    assert_eq!(
        blob_hash_to_hex(&hash).to_string(),
        "f015e34d6caf50a3dc012ce5d7e6732362e6835852a1d4140bc97448faa28c5b712d7c065129c942699af05d9d6517ee1063b4ca4c625f13a61a936e2806d574",
    );
}

#[test]
fn slice_to_blob_hash_copies_exact_length_slice() {
    let input = [0x5a; BLOB_HASH_LENGTH];

    assert_eq!(slice_to_blob_hash(&input), input);
}

#[test]
#[should_panic]
fn slice_to_blob_hash_rejects_wrong_length_slice() {
    slice_to_blob_hash(&[0x5a; BLOB_HASH_LENGTH - 1]);
}
