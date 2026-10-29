"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const photo=require("../listing-photo-selection");

test("Use Enhanced Photo selects the preview file but does not replace it before explicit save",()=>{
  const original={name:"original.jpg"},enhanced={name:"cleaned.jpg"},candidate={file:enhanced,dataUrl:"data:image/jpeg;base64,clean"};
  const selected=photo.accept(candidate);assert.equal(selected.file,enhanced);assert.equal(selected.dataUrl,candidate.dataUrl);
  assert.equal(photo.imageField({pendingImageFile:selected.file,editingItemId:"42",existingImageUrl:"https://storage/original.jpg"}),undefined);
});
test("Keep Original retains the newly selected source photo",()=>{
  const original={name:"original.jpg"},restored=photo.restore({sourceFile:original,sourceDataUrl:"data:image/jpeg;base64,original",editingItemId:"42",existingImageUrl:"https://storage/saved.jpg"});
  assert.equal(restored.file,original);assert.equal(restored.dataUrl,"data:image/jpeg;base64,original");
});
test("restoring an existing listing uses its untouched saved image and no replacement upload",()=>{
  const restored=photo.restore({sourceFile:null,sourceDataUrl:"",editingItemId:"42",existingImageUrl:"https://storage/original.jpg"});
  assert.equal(restored.file,null);assert.equal(restored.dataUrl,"https://storage/original.jpg");
  assert.equal(photo.imageField({pendingImageFile:null,editingItemId:"42",existingImageUrl:"https://storage/original.jpg"}),"https://storage/original.jpg");
});
