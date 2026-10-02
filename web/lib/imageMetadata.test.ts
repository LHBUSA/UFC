/* Image rights metadata. Run: npm run test:image-metadata */
import test from "node:test";
import assert from "node:assert/strict";
import { ownedImage, licensedImage, compositeImage, imageObject, portraitImage, isKnown, ccLicenseUrl, creatorTypeFor } from "./imageMetadata.ts";

const commons = { portrait: "https://x/p.webp", card: "https://x/c.webp", license: "CC BY-SA 4.0", author: "Gismat", source_url: "https://commons.wikimedia.org/wiki/File:X.jpg", kind: "wikimedia", source_family: "wikimedia" };
const espn = { portrait: "https://a.espncdn.com/i/headshots/mma/players/full/1.png", license: null, author: null, source_url: null, source_family: "espn", rights_label: "display_only" };

test("logos are PropBetEdge art", () => {
  const node = imageObject(ownedImage({ url: "https://propbetedge.ai/logo/pbe-full-600.png", width: 1076, height: 600 }))!;
  assert.deepEqual(node.creator, { "@type": "Organization", name: "PropBetEdge" });
  assert.equal(node.copyrightNotice, "© 2026 PropBetEdge");
});

test("Commons catalog photo is credited to its photographer with the CC deed", () => {
  const node = imageObject(portraitImage(commons, { caption: "Mehemmedeli Osmanli" }))!;
  assert.deepEqual(node.creator, { "@type": "Person", name: "Gismat" });
  assert.equal(node.copyrightNotice, "Gismat / CC BY-SA 4.0");
  assert.equal(node.license, "https://creativecommons.org/licenses/by-sa/4.0/");
  assert.equal(node.acquireLicensePage, commons.source_url);
});

test("ESPN display-only headshot and author-less photos are held", () => {
  assert.equal(isKnown(portraitImage(espn)), false);
  const node = imageObject(portraitImage(espn))!;
  assert.equal(node.creator, undefined);
  assert.equal(node.copyrightNotice, undefined);
  assert.equal(isKnown(portraitImage({ ...commons, author: null })), false);
});

test("share card on a credited photo credits it; on an unknown photo it is held", () => {
  const photo = portraitImage(commons)!;
  const card = imageObject(compositeImage({ url: "https://ufc/x/opengraph-image", width: 1200, height: 630, year: "2026-10-01", parts: [photo] }))!;
  assert.equal(card.copyrightNotice, "© 2026 PropBetEdge. Photo: Gismat / CC BY-SA 4.0");
  assert.equal(card.license, "https://creativecommons.org/licenses/by-sa/4.0/");
  const held = imageObject(compositeImage({ url: "u", parts: [portraitImage(espn)] }))!;
  assert.equal(held.creator, undefined);
  assert.equal(held.copyrightNotice, undefined);
});

test("license deeds and creator types", () => {
  assert.equal(ccLicenseUrl("CC BY 3.0"), "https://creativecommons.org/licenses/by/3.0/");
  assert.equal(ccLicenseUrl("CC0"), "https://creativecommons.org/publicdomain/zero/1.0/");
  assert.equal(ccLicenseUrl("Public domain"), null);
  assert.equal(creatorTypeFor("The White House"), "Organization");
  assert.equal(creatorTypeFor("Lorie Shaull from St Paul, United States"), "Person");
  assert.equal(creatorTypeFor("MMAnytt"), "Organization");
  assert.equal(creatorTypeFor("Gage Skidmore"), "Person");
  for (const junk of ["Unknown authorUnknown author", "[1]", "Copyright holder release per the ticket", "File:x.jpg: PLEASE COMPLETE AUTHOR INFORMATION derivative work: A"]) {
    assert.equal(isKnown(licensedImage({ url: "u", author: junk, license: "CC BY 2.0" })), false, junk);
  }
  const pd = imageObject(licensedImage({ url: "u", author: "The White House", license: "Public domain" }))!;
  assert.equal(pd.copyrightNotice, "The White House / Public domain");
  assert.equal(pd.license, undefined);
});
