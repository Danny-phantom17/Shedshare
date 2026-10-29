"use strict";
(function exposePhotoSelection(root) {
  const api=Object.freeze({
    accept(candidate){return candidate&&candidate.file&&candidate.dataUrl?{file:candidate.file,dataUrl:candidate.dataUrl}:null;},
    restore({sourceFile,sourceDataUrl,editingItemId,existingImageUrl}){
      if(sourceFile&&sourceDataUrl)return{file:sourceFile,dataUrl:sourceDataUrl};
      if(editingItemId&&existingImageUrl)return{file:null,dataUrl:existingImageUrl};
      return null;
    },
    imageField({pendingImageFile,editingItemId,existingImageUrl}){
      if(pendingImageFile)return editingItemId?undefined:"";
      return existingImageUrl||"";
    }
  });
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else root.ShedSharePhotoSelection=api;
})(globalThis);
