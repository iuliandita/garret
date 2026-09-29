use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::{parse_macro_input, FnArg, GenericArgument, ItemFn, Pat, PathArguments, ReturnType, Type};

/// Keep domain functions callable with their original error types. Only the
/// generated IPC adapter changes failure serialization.
#[proc_macro_attribute]
pub fn command(attributes: TokenStream, input: TokenStream) -> TokenStream {
    let function = parse_macro_input!(input as ItemFn);
    match expand(function, attributes.into()) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.into_compile_error().into(),
    }
}

fn expand(function: ItemFn, attributes: proc_macro2::TokenStream) -> syn::Result<proc_macro2::TokenStream> {
    let name = &function.sig.ident;
    let wire_name = name.to_string();
    let mut signature = function.sig.clone();
    signature.ident = format_ident!("__wire_{}", name);
    let mut args = Vec::new();
    for argument in &signature.inputs {
        let FnArg::Typed(argument) = argument else {
            return Err(syn::Error::new_spanned(argument, "commands cannot have self arguments"));
        };
        let Pat::Ident(binding) = argument.pat.as_ref() else {
            return Err(syn::Error::new_spanned(argument, "command arguments must be named"));
        };
        args.push(binding.ident.clone());
    }
    let mut call = quote!(#name(#(#args),*));
    if signature.asyncness.is_some() {
        call = quote!(#call.await);
    }
    if let ReturnType::Type(_, output) = &signature.output {
        if let Type::Path(path) = output.as_ref() {
            let last = path.path.segments.last().expect("type path has a segment");
            if last.ident == "Result" {
                let PathArguments::AngleBracketed(arguments) = &last.arguments else {
                    return Err(syn::Error::new_spanned(output, "command Result needs explicit success and error types"));
                };
                let Some(GenericArgument::Type(success)) = arguments.args.first() else {
                    return Err(syn::Error::new_spanned(output, "command Result needs a success type"));
                };
                if arguments.args.len() != 2 {
                    return Err(syn::Error::new_spanned(output, "command Result needs explicit error type"));
                }
                signature.output = syn::parse_quote!(-> std::result::Result<#success, crate::command_error::CommandFailure>);
                call = quote!(#call.map_err(|detail| crate::command_error::CommandFailure::operation(#wire_name, detail)));
            }
        }
    }
    let visibility = &function.vis;
    let attrs = &function.attrs;
    // Tauri validates its own forwarded attributes, including rename_all.
    Ok(quote! {
        #function
        #(#attrs)*
        #[tauri::command(rename = #wire_name, #attributes)]
        #visibility #signature { #call }
    })
}
